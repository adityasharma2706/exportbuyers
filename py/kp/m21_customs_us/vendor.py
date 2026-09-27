"""M21 vendor interface (``fetch(week) -> files``) and vendor-file parsing into bill-of-lading rows.

The US customs vendor is still an open question (architecture OQ1), so the vendor sits behind the
``CustomsUsVendor`` protocol. The one implementation shipped here, ``DropVendor``, reads a licensed
bulk delivery that the vendor drops into object storage (or a local directory in dev) under
``<drop_uri>/week=YYYY-WW/``. That is how the common bulk BOL vendors deliver data; an API-based
vendor only needs another ``CustomsUsVendor``.

Files may be CSV (optionally gzip), JSON Lines (optionally gzip) or Parquet. Vendor column names are
mapped onto the LLD schema through aliases (``config/customs_us.yaml`` → ``columns``).
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Protocol
from urllib.parse import urlsplit

from kp.m01_platform import KpError, assert_india_region, get_config, get_logger

from .models import BolRow, IsoWeek

_log = get_logger("kp.m21_customs_us.vendor")

MAX_TEXT = 2000
KG_PER_UNIT: dict[str, float] = {
    "KG": 1.0, "KGS": 1.0, "K": 1.0, "KILOGRAM": 1.0, "KILOGRAMS": 1.0,
    "LB": 0.45359237, "LBS": 0.45359237, "L": 0.45359237, "POUND": 0.45359237, "POUNDS": 0.45359237,
    "T": 1000.0, "MT": 1000.0, "TON": 1000.0, "TONNE": 1000.0, "TONNES": 1000.0,
    "G": 0.001, "GRAM": 0.001, "GRAMS": 0.001,
}

# Canonical field → accepted vendor column names (compared case-insensitively, punctuation ignored).
DEFAULT_COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
    "bol_id": ("bol_id", "bol", "bill_of_lading", "bill_of_lading_number", "bol_number", "master_bol",
               "house_bol", "bill_no"),
    "arrival_date": ("arrival_date", "actual_arrival_date", "estimated_arrival_date", "arrival", "date"),
    "consignee_name": ("consignee_name", "consignee", "importer", "importer_name"),
    "consignee_addr": ("consignee_addr", "consignee_address", "importer_address", "consignee_full_address"),
    "shipper_name": ("shipper_name", "shipper", "exporter", "supplier", "exporter_name"),
    "shipper_country": ("shipper_country", "country_of_origin", "origin_country", "shipper_country_code",
                        "foreign_country", "country"),
    "hs_code": ("hs_code", "hs", "hts", "hts_code", "harmonized_code", "harmonized_number", "hs_codes"),
    "description": ("description", "product_description", "goods_description", "cargo_description"),
    "weight_kg": ("weight_kg", "weight_in_kg", "gross_weight_kg", "weight", "gross_weight"),
    "weight_unit": ("weight_unit", "weight_uom", "unit_of_weight"),
    "teu": ("teu", "teus"),
}

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_TO_ORDER = re.compile(r"^\s*(to\s+(the\s+)?order(\s+of)?|same\s+as\s+(notify|consignee)|n/?a|none|unknown|-+)\b",
                       re.IGNORECASE)
_US_DATE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")


def _col(s: str) -> str:
    return _NON_ALNUM.sub("_", s.strip().lower()).strip("_")


# ---- the vendor interface -------------------------------------------------------------------------

@dataclass(frozen=True)
class VendorFile:
    name: str
    body: bytes
    content_type: str
    url: str | None = None
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    cost_micros_inr: int = 0


class CustomsUsVendor(Protocol):
    name: str

    def fetch(self, week: IsoWeek) -> Iterable[VendorFile]:
        """All files of the vendor's delivery for ``week`` (empty when nothing was delivered)."""
        ...


def content_type_for(name: str) -> str:
    n = name.lower()
    if n.endswith(".parquet"):
        return "application/vnd.apache.parquet"
    if n.endswith((".jsonl", ".ndjson", ".jsonl.gz", ".ndjson.gz")):
        return "application/x-ndjson" + ("+gzip" if n.endswith(".gz") else "")
    if n.endswith((".csv", ".csv.gz", ".tsv", ".tsv.gz", ".txt", ".txt.gz")):
        return "text/csv" + ("+gzip" if n.endswith(".gz") else "")
    return "application/octet-stream"


_SUPPORTED_SUFFIXES = (".parquet", ".jsonl", ".ndjson", ".csv", ".tsv", ".txt",
                       ".jsonl.gz", ".ndjson.gz", ".csv.gz", ".tsv.gz", ".txt.gz")


class DropVendor:
    """A delivery dropped under ``<drop_uri>/week=YYYY-WW/`` (``s3://bucket/prefix`` or a local path).

    A ``_SUCCESS`` / ``_manifest.json`` marker is not required, but files still being written are
    avoided by ignoring names starting with ``_`` or ``.`` and temporary suffixes.
    """

    def __init__(self, name: str, drop_uri: str, *, s3_client: Any = None, cost_micros_per_file: int = 0) -> None:
        self.name = name
        self.drop_uri = drop_uri.rstrip("/")
        self._s3 = s3_client
        self._cost = max(0, int(cost_micros_per_file))

    def _week_prefix(self, week: IsoWeek) -> str:
        return f"{self.drop_uri}/week={week}"

    @staticmethod
    def _wanted(name: str) -> bool:
        base = name.rsplit("/", 1)[-1]
        return bool(base) and not base.startswith(("_", ".")) and base.lower().endswith(_SUPPORTED_SUFFIXES)

    def fetch(self, week: IsoWeek) -> Iterator[VendorFile]:
        prefix = self._week_prefix(week)
        parts = urlsplit(prefix)
        if parts.scheme == "s3":
            yield from self._fetch_s3(parts.netloc, parts.path.lstrip("/") + "/")
        elif parts.scheme in ("", "file"):
            yield from self._fetch_dir(Path(parts.path if parts.scheme == "file" else prefix))
        else:
            raise KpError("VALIDATION", "drop_uri must be s3:// or a local path", {"drop_uri": self.drop_uri})

    def _client(self) -> Any:
        if self._s3 is None:
            import boto3

            self._s3 = boto3.client("s3", region_name=assert_india_region(get_config().region, "customs drop bucket"))
        return self._s3

    def _fetch_s3(self, bucket: str, prefix: str) -> Iterator[VendorFile]:
        s3 = self._client()
        token: str | None = None
        keys: list[str] = []
        try:
            while True:
                kw: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
                if token:
                    kw["ContinuationToken"] = token
                page = s3.list_objects_v2(**kw)
                keys.extend(o["Key"] for o in page.get("Contents", []) if self._wanted(o["Key"]))
                if not page.get("IsTruncated"):
                    break
                token = page.get("NextContinuationToken")
        except KpError:
            raise
        except Exception as e:
            raise KpError("UPSTREAM_UNAVAILABLE", "Listing the customs vendor drop failed",
                          {"bucket": bucket, "prefix": prefix}) from e
        for key in sorted(keys):
            try:
                body: bytes = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            except Exception as e:
                raise KpError("UPSTREAM_UNAVAILABLE", "Reading a customs vendor file failed",
                              {"bucket": bucket, "key": key}) from e
            yield VendorFile(name=key.rsplit("/", 1)[-1], body=body, content_type=content_type_for(key),
                             url=f"s3://{bucket}/{key}", cost_micros_inr=self._cost)

    def _fetch_dir(self, path: Path) -> Iterator[VendorFile]:
        if not path.is_dir():
            return
        for p in sorted(path.iterdir()):
            if p.is_file() and self._wanted(p.name):
                yield VendorFile(name=p.name, body=p.read_bytes(), content_type=content_type_for(p.name),
                                 url=p.resolve().as_uri(), cost_micros_inr=self._cost)


# ---- parsing --------------------------------------------------------------------------------------

@dataclass
class ParseStats:
    rows: int = 0
    rejected: int = 0
    reasons: dict[str, int] = field(default_factory=dict)

    def reject(self, reason: str) -> None:
        self.rejected += 1
        self.reasons[reason] = self.reasons.get(reason, 0) + 1


class ColumnMap:
    """Resolves vendor headers onto canonical field names."""

    def __init__(self, aliases: Mapping[str, Iterable[str]] | None = None) -> None:
        merged: dict[str, list[str]] = {k: list(v) for k, v in DEFAULT_COLUMN_ALIASES.items()}
        for k, v in (aliases or {}).items():
            if k not in DEFAULT_COLUMN_ALIASES:
                raise KpError("VALIDATION", f"Unknown customs column '{k}' in column aliases")
            # Configured aliases take precedence over the defaults.
            merged[k] = [*v, *(x for x in merged[k] if x not in v)]
        self.aliases = {k: [_col(a) for a in v] for k, v in merged.items()}

    def resolve(self, headers: Iterable[str]) -> dict[str, str]:
        """canonical → the actual header, for every canonical field present."""
        by_norm: dict[str, str] = {}
        for h in headers:
            by_norm.setdefault(_col(str(h)), str(h))
        out: dict[str, str] = {}
        taken: set[str] = set()
        for canon, names in self.aliases.items():
            for n in names:
                actual = by_norm.get(n)
                if actual is not None and actual not in taken:
                    out[canon] = actual
                    taken.add(actual)
                    break
        missing = [c for c in ("bol_id", "arrival_date", "consignee_name") if c not in out]
        if missing:
            raise KpError("VALIDATION", "Customs file lacks required columns", {"missing": missing})
        return out


def _text(v: Any, max_len: int = MAX_TEXT) -> str | None:
    if v is None:
        return None
    s = " ".join(str(v).split())
    return s[:max_len] if s else None


def parse_date(v: Any) -> date | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    if not s:
        return None
    m = _US_DATE.match(s)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
    for candidate in (s[:10], s[:8]):
        try:
            if len(candidate) == 8 and candidate.isdigit():
                return datetime.strptime(candidate, "%Y%m%d").date()
            return date.fromisoformat(candidate)
        except ValueError:
            continue
    return None


def parse_number(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
    else:
        s = str(v).strip().replace(",", "")
        if not s:
            return None
        try:
            f = float(s)
        except ValueError:
            return None
    if f != f or f < 0 or f in (float("inf"),):
        return None
    return f


def parse_weight_kg(v: Any, unit: Any) -> float | None:
    w = parse_number(v)
    if w is None:
        return None
    u = str(unit or "KG").strip().upper()
    factor = KG_PER_UNIT.get(u)
    if factor is None:
        return None
    return w * factor


_country_cache: dict[str, str | None] = {}


def country_code(v: Any) -> str | None:
    """ISO 3166-1 alpha-2 from an alpha-2 / alpha-3 code or a country name."""
    s = _text(v, 100)
    if not s:
        return None
    key = s.upper()
    if key in _country_cache:
        return _country_cache[key]
    out: str | None = None
    try:
        import pycountry

        if len(key) == 2 and key.isalpha():
            c = pycountry.countries.get(alpha_2=key)
            out = c.alpha_2 if c else None
        elif len(key) == 3 and key.isalpha():
            c = pycountry.countries.get(alpha_3=key)
            out = c.alpha_2 if c else None
        if out is None:
            try:
                out = pycountry.countries.lookup(s).alpha_2
            except LookupError:
                out = None
    except ImportError:
        out = key if len(key) == 2 and key.isalpha() else None
    _country_cache[key] = out
    return out


def normalise_hs_code(v: Any) -> str | None:
    """Digits only; the first code when the vendor lists several. ``None`` when fewer than 4 digits."""
    s = _text(v, 200)
    if not s:
        return None
    first = re.split(r"[;,|/ ]+", s.strip())[0]
    digits = "".join(ch for ch in first if ch.isdigit())
    return digits[:10] if len(digits) >= 4 else None


def is_placeholder_consignee(name: str | None) -> bool:
    return not name or bool(_TO_ORDER.match(name)) or not any(ch.isalpha() for ch in name)


def row_from_mapping(raw: Mapping[str, Any], cols: Mapping[str, str], stats: ParseStats) -> BolRow | None:
    def g(canon: str) -> Any:
        h = cols.get(canon)
        return raw.get(h) if h is not None else None

    stats.rows += 1
    bol = _text(g("bol_id"), 100)
    if not bol:
        stats.reject("no_bol_id")
        return None
    arrival = parse_date(g("arrival_date"))
    if arrival is None:
        stats.reject("bad_arrival_date")
        return None
    consignee = _text(g("consignee_name"), 500)
    if is_placeholder_consignee(consignee):
        stats.reject("no_consignee")
        return None
    assert consignee is not None
    return BolRow(
        bol_id=bol,
        arrival_date=arrival,
        consignee_name=consignee,
        consignee_addr=_text(g("consignee_addr"), 2000),
        shipper_name=_text(g("shipper_name"), 500),
        shipper_country=country_code(g("shipper_country")),
        hs_code=normalise_hs_code(g("hs_code")),
        description=_text(g("description")),
        weight_kg=parse_weight_kg(g("weight_kg"), g("weight_unit")) if "weight_kg" in cols else None,
        teu=parse_number(g("teu")),
    )


def _decompress(body: bytes, content_type: str) -> bytes:
    if content_type.endswith("+gzip") or body[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(body)
        except OSError as e:
            raise KpError("VALIDATION", "Customs file is not valid gzip") from e
    return body


def _iter_csv(body: bytes) -> Iterator[Mapping[str, Any]]:
    text = body.decode("utf-8-sig", errors="replace")
    sample = text[:65536]
    try:
        dialect: Any = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    yield from csv.DictReader(io.StringIO(text), dialect=dialect)


def _iter_jsonl(body: bytes) -> Iterator[Mapping[str, Any]]:
    for i, line in enumerate(body.decode("utf-8", errors="replace").splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise KpError("VALIDATION", "Customs JSONL line is not valid JSON", {"line": i + 1}) from e
        if isinstance(obj, dict):
            yield obj


def _iter_parquet(body: bytes) -> Iterator[Mapping[str, Any]]:
    import pyarrow.parquet as pq

    pf = pq.ParquetFile(io.BytesIO(body))
    for batch in pf.iter_batches(batch_size=10_000):
        yield from batch.to_pylist()


def iter_raw_rows(body: bytes, content_type: str) -> Iterator[Mapping[str, Any]]:
    ct = content_type.split("+", 1)[0]
    data = _decompress(body, content_type)
    if ct == "application/vnd.apache.parquet":
        return _iter_parquet(data)
    if ct == "application/x-ndjson":
        return _iter_jsonl(data)
    if ct == "text/csv":
        return _iter_csv(data)
    raise KpError("VALIDATION", "Unsupported customs file type", {"content_type": content_type})


def parse_vendor_file(body: bytes, content_type: str, columns: ColumnMap | None = None,
                      stats: ParseStats | None = None) -> Iterator[BolRow]:
    """Canonical BOL rows from one vendor file. Rows without a BOL id, a parseable arrival date or a
    real consignee ("TO ORDER" and the like) are rejected and counted in ``stats``."""
    cm = columns or ColumnMap()
    st = stats if stats is not None else ParseStats()
    cols: dict[str, str] | None = None
    for raw in iter_raw_rows(body, content_type):
        if cols is None:
            cols = cm.resolve(raw.keys())
        row = row_from_mapping(raw, cols, st)
        if row is not None:
            yield row
    if st.rejected:
        _log.info("customs rows rejected", extra={"rows": st.rows, "rejected": st.rejected, "reasons": st.reasons})
