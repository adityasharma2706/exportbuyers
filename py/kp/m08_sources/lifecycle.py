"""M08 nightly job: re-sync raw-bucket lifecycle rules from ``retention_days``.

``m08.sync_raw_lifecycle`` (knowledge queue, 02:30 UTC daily):
  1. reads every knowledge.source row;
  2. writes the bucket lifecycle configuration: a baseline rule (abort stale multipart uploads,
     drop non-current versions) plus one expiration rule per source prefix with retention_days;
  3. deletes knowledge.raw_object rows whose expires_at has passed (S3 expires the objects);
  4. logs any drift between the database register and /config/sources.yaml.
"""
from __future__ import annotations

from typing import Any, Mapping, Sequence

from kp.m01_platform import KpError, assert_india_region, get_config, get_logger, get_secret
from kp.m02_queue import JobMeta, register_handler, register_schedule

from .register import SourceEntry, list_register_rows, load_register_file
from .storage import raw_bucket_name, source_prefix

SYNC_LIFECYCLE_JOB = "m08.sync_raw_lifecycle"
SYNC_LIFECYCLE_SCHEDULE = "m08.sync-raw-lifecycle"
SYNC_LIFECYCLE_CRON = "30 2 * * *"
BASELINE_RULE_ID = "m08-baseline"
MAX_LIFECYCLE_RULES = 1000  # S3 limit

_log = get_logger("kp.m08_sources.lifecycle")


def rule_id_for(source_id: str) -> str:
    return f"m08-src-{source_id}"[:255]


def build_lifecycle_rules(entries: Sequence[SourceEntry]) -> list[dict[str, Any]]:
    """S3 lifecycle rules for the raw bucket. Deterministic order (by source id)."""
    rules: list[dict[str, Any]] = [{
        "ID": BASELINE_RULE_ID,
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1},
        "NoncurrentVersionExpiration": {"NoncurrentDays": 1},
    }]
    for e in sorted(entries, key=lambda x: x.id):
        if e.retention_days is None:
            continue
        rules.append({
            "ID": rule_id_for(e.id),
            "Status": "Enabled",
            "Filter": {"Prefix": source_prefix(e.id)},
            "Expiration": {"Days": e.retention_days},
            "NoncurrentVersionExpiration": {"NoncurrentDays": 1},
        })
    if len(rules) > MAX_LIFECYCLE_RULES:
        raise KpError("INTERNAL", f"Too many lifecycle rules ({len(rules)} > {MAX_LIFECYCLE_RULES})")
    return rules


def apply_lifecycle_rules(rules: list[dict[str, Any]], *, client: Any = None, bucket: str | None = None) -> None:
    if client is None:
        import boto3

        client = boto3.client("s3", region_name=assert_india_region(get_config().region, "raw bucket"))
    try:
        client.put_bucket_lifecycle_configuration(
            Bucket=bucket or raw_bucket_name(),
            LifecycleConfiguration={"Rules": rules},
        )
    except Exception as e:
        raise KpError("UPSTREAM_UNAVAILABLE", "Could not update raw bucket lifecycle rules") from e


def register_drift(db_entries: Sequence[SourceEntry], file_entries: Sequence[SourceEntry]) -> list[str]:
    """Human-readable differences between the database register and config/sources.yaml."""
    ignore = {"domains"}  # YAML-only field
    db = {e.id: e for e in db_entries}
    fs = {e.id: e for e in file_entries}
    out: list[str] = []
    for sid in sorted(set(db) | set(fs)):
        a, b = db.get(sid), fs.get(sid)
        if a is None:
            out.append(f"{sid}: in sources.yaml but not in the database")
            continue
        if b is None:
            out.append(f"{sid}: in the database but not in sources.yaml")
            continue
        for f in a.__dataclass_fields__:
            if f in ignore:
                continue
            va, vb = getattr(a, f), getattr(b, f)
            if va != vb:
                out.append(f"{sid}: {f} differs (database={va!r}, file={vb!r})")
    return out


_PURGE_EXPIRED = (
    "delete from knowledge.raw_object where id in ("
    " select id from knowledge.raw_object where expires_at is not null and expires_at < now() limit 5000)"
)


def sync_raw_lifecycle(conn: Any, *, s3_client: Any = None, bucket: str | None = None) -> Mapping[str, Any]:
    """One pass of the nightly job, using the caller's psycopg connection for the database work."""
    entries = list_register_rows(conn)
    rules = build_lifecycle_rules(entries)
    apply_lifecycle_rules(rules, client=s3_client, bucket=bucket)
    purged = 0
    while True:
        cur = conn.execute(_PURGE_EXPIRED)
        n = cur.rowcount or 0
        conn.commit()
        purged += n
        if n < 5000:
            break
    drift: list[str] = []
    try:
        drift = register_drift(entries, load_register_file())
    except KpError:
        _log.exception("could not read config/sources.yaml for the drift check")
    if drift:
        _log.error("source register drift between database and config/sources.yaml", extra={"drift": drift})
    result = {"rules": len(rules), "purged_raw_rows": purged, "drift": drift}
    _log.info("raw lifecycle synced", extra=result)
    return result


def _handle(_payload: Any, _meta: JobMeta) -> None:
    import psycopg

    with psycopg.connect(get_secret("DATABASE_URL")) as conn:
        sync_raw_lifecycle(conn)


def register_source_jobs() -> None:
    """Call once at knowledge-plane worker boot."""
    register_handler(SYNC_LIFECYCLE_JOB, None, _handle)
    register_schedule(SYNC_LIFECYCLE_SCHEDULE, SYNC_LIFECYCLE_CRON, SYNC_LIFECYCLE_JOB, {"v": 1}, "knowledge")
