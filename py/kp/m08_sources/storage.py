"""M08 raw landing storage: dated, immutable object storage plus the knowledge.raw_object index.

Layout: ``s3://<raw bucket>/<source_id>/<yyyy>/<mm>/<dd>/<sha256>``. The bucket has versioning
and Object Lock (governance mode); each object is written with a retain-until date equal to its
expiry so it cannot be rewritten or removed early. Writes are conditional (``If-None-Match: *``)
so a key is never overwritten, and landing is idempotent on (source_id, sha256) through the
``knowledge.raw_object`` unique index.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Protocol

from kp.m01_platform import KpError, assert_india_region, get_config, get_secret

# Objects of sources with no retention_days are still locked, for this many days [tunable].
DEFAULT_LOCK_DAYS = 365


def raw_bucket_name() -> str:
    """RAW_BUCKET env var, else ``exportbuyers-<env>-raw`` (matches infra/terraform/m08_raw_bucket.tf)."""
    explicit = os.environ.get("RAW_BUCKET")
    if explicit:
        return explicit
    return f"exportbuyers-{get_config().app_env}-raw"


def raw_key(source_id: str, sha256: str, fetched_at: datetime) -> str:
    at = fetched_at.astimezone(timezone.utc)
    return f"{source_id}/{at:%Y}/{at:%m}/{at:%d}/{sha256}"


def source_prefix(source_id: str) -> str:
    return f"{source_id}/"


def expiry_for(retention_days: int | None, fetched_at: datetime) -> datetime | None:
    return None if retention_days is None else fetched_at + timedelta(days=retention_days)


class RawStore(Protocol):
    def put_if_absent(
        self, key: str, body: bytes, *, content_type: str, sha256: str, retain_until: datetime,
        metadata: Mapping[str, str] | None = None,
    ) -> bool:
        """Writes the object unless the key exists. Returns True when it wrote."""
        ...

    def get(self, key: str) -> bytes: ...

    def exists(self, key: str) -> bool: ...


class S3RawStore:
    def __init__(self, bucket: str | None = None, region: str | None = None, client: Any = None) -> None:
        self.bucket = bucket or raw_bucket_name()
        if client is None:
            import boto3

            client = boto3.client("s3", region_name=assert_india_region(region or get_config().region, "raw bucket"))
        self._s3 = client

    def exists(self, key: str) -> bool:
        try:
            self._s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception as e:  # botocore ClientError
            if _error_code(e) in ("404", "NoSuchKey", "NotFound"):
                return False
            raise KpError("UPSTREAM_UNAVAILABLE", "Raw storage lookup failed", {"key": key}) from e

    def put_if_absent(
        self, key: str, body: bytes, *, content_type: str, sha256: str, retain_until: datetime,
        metadata: Mapping[str, str] | None = None,
    ) -> bool:
        if self.exists(key):
            return False
        try:
            self._s3.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=body,
                ContentType=content_type,
                Metadata=dict(metadata or {}),
                ServerSideEncryption="aws:kms",
                ChecksumAlgorithm="SHA256",
                IfNoneMatch="*",
                ObjectLockMode="GOVERNANCE",
                ObjectLockRetainUntilDate=retain_until,
            )
            return True
        except Exception as e:
            if _error_code(e) in ("PreconditionFailed", "412", "ConditionalRequestConflict"):
                return False  # a concurrent writer landed the same key first
            raise KpError("UPSTREAM_UNAVAILABLE", "Raw storage write failed", {"key": key}) from e

    def get(self, key: str) -> bytes:
        try:
            out = self._s3.get_object(Bucket=self.bucket, Key=key)
        except Exception as e:
            if _error_code(e) in ("404", "NoSuchKey", "NotFound"):
                raise KpError("NOT_FOUND", "Raw object not found", {"key": key}) from e
            raise KpError("UPSTREAM_UNAVAILABLE", "Raw storage read failed", {"key": key}) from e
        data: bytes = out["Body"].read()
        return data


def _error_code(e: Exception) -> str | None:
    resp = getattr(e, "response", None)
    if isinstance(resp, Mapping):
        err = resp.get("Error")
        if isinstance(err, Mapping) and err.get("Code") is not None:
            return str(err.get("Code"))
    return None


class MemoryRawStore:
    """In-process store with the same write-once semantics (tests and local dev)."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, dict[str, Any]]] = {}
        self._lock = threading.Lock()

    def exists(self, key: str) -> bool:
        with self._lock:
            return key in self.objects

    def put_if_absent(
        self, key: str, body: bytes, *, content_type: str, sha256: str, retain_until: datetime,
        metadata: Mapping[str, str] | None = None,
    ) -> bool:
        with self._lock:
            if key in self.objects:
                return False
            self.objects[key] = (bytes(body), {
                "content_type": content_type, "sha256": sha256, "retain_until": retain_until,
                "metadata": dict(metadata or {}),
            })
            return True

    def get(self, key: str) -> bytes:
        with self._lock:
            hit = self.objects.get(key)
        if hit is None:
            raise KpError("NOT_FOUND", "Raw object not found", {"key": key})
        return hit[0]


# ---- knowledge.raw_object index ------------------------------------------------------------

@dataclass(frozen=True)
class RawObjectRow:
    id: str
    source_id: str
    s3_key: str
    sha256: str
    fetched_at: datetime
    url: str | None
    bytes: int
    expires_at: datetime | None


class RawIndex(Protocol):
    def find(self, source_id: str, sha256: str) -> RawObjectRow | None: ...

    def insert(self, row: RawObjectRow) -> RawObjectRow:
        """Inserts the row; on a (source_id, sha256) conflict returns the existing row."""
        ...


_COLS = "id, source_id, s3_key, sha256, fetched_at, url, bytes, expires_at"


def _row(r: Mapping[str, Any]) -> RawObjectRow:
    return RawObjectRow(
        id=str(r["id"]), source_id=r["source_id"], s3_key=r["s3_key"], sha256=r["sha256"],
        fetched_at=r["fetched_at"], url=r["url"], bytes=int(r["bytes"]), expires_at=r["expires_at"],
    )


class DbRawIndex:
    """knowledge.raw_object via psycopg. Uses its own short connection per call."""

    def __init__(self, dsn: str | None = None) -> None:
        self._dsn = dsn

    def _connect(self) -> Any:
        import psycopg
        from psycopg.rows import dict_row

        return psycopg.connect(self._dsn or get_secret("DATABASE_URL"), autocommit=True, row_factory=dict_row)

    def find(self, source_id: str, sha256: str) -> RawObjectRow | None:
        with self._connect() as conn:
            r = conn.execute(
                f"select {_COLS} from knowledge.raw_object where source_id = %s and sha256 = %s",
                (source_id, sha256),
            ).fetchone()
        return _row(r) if r else None

    def insert(self, row: RawObjectRow) -> RawObjectRow:
        with self._connect() as conn:
            r = conn.execute(
                f"insert into knowledge.raw_object ({_COLS}) values (%s, %s, %s, %s, %s, %s, %s, %s) "
                f"on conflict (source_id, sha256) do nothing returning {_COLS}",
                (row.id, row.source_id, row.s3_key, row.sha256, row.fetched_at, row.url, row.bytes, row.expires_at),
            ).fetchone()
            if r is None:
                r = conn.execute(
                    f"select {_COLS} from knowledge.raw_object where source_id = %s and sha256 = %s",
                    (row.source_id, row.sha256),
                ).fetchone()
        if r is None:
            raise KpError("INTERNAL", "raw_object insert conflicted but no existing row was found",
                          {"source_id": row.source_id, "sha256": row.sha256})
        return _row(r)


class MemoryRawIndex:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], RawObjectRow] = {}
        self._lock = threading.Lock()

    def find(self, source_id: str, sha256: str) -> RawObjectRow | None:
        with self._lock:
            return self.rows.get((source_id, sha256))

    def insert(self, row: RawObjectRow) -> RawObjectRow:
        with self._lock:
            return self.rows.setdefault((row.source_id, row.sha256), row)
