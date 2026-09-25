"""M08 source licence register (IF-08a).

``get_source(source_id)`` returns the register entry for an *active* source and raises
``SourceNotRegistered`` / ``SourceNotActive`` otherwise. Entries are read from
``knowledge.source`` and cached for a short TTL so that disabling a source takes effect within
a minute without a redeploy.

The register itself is defined in ``/config/sources.yaml`` and seeded by migration;
``load_register_file`` parses and validates that file (used by tests and by the nightly drift
check in ``lifecycle.py``).
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Literal, Mapping, Sequence

from kp.m01_platform import KpError, get_logger, get_secret

SourceType = Literal[
    "customs", "website", "directory", "registry", "sanctions", "market_stats", "nomenclature",
    "user_report", "operator",
]
SOURCE_TYPES: tuple[str, ...] = (
    "customs", "website", "directory", "registry", "sanctions", "market_stats", "nomenclature",
    "user_report", "operator",
)
PersonalDataClass = Literal["none", "business_contact", "named_person"]
PERSONAL_DATA_CLASSES: tuple[str, ...] = ("none", "business_contact", "named_person")
SourceStatus = Literal["active", "disabled", "prohibited"]
SOURCE_STATUSES: tuple[str, ...] = ("active", "disabled", "prohibited")
ALL_REGIONS = "*"

SOURCE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,99}$")
_REGION_RE = re.compile(r"^[A-Z]{2}$")

# Defence in depth: these hosts are never fetched and these ids never run, whatever the
# database says. Mirrors the `domains` of the prohibited rows in config/sources.yaml (a test
# keeps the two in step).
PROHIBITED_SOURCE_IDS: frozenset[str] = frozenset({"linkedin", "social.meta", "social.x"})
PROHIBITED_HOSTS: frozenset[str] = frozenset(
    {"linkedin.com", "lnkd.in", "facebook.com", "fb.com", "instagram.com", "x.com", "twitter.com"}
)

CACHE_TTL_S = 60.0  # [tunable]

_log = get_logger("kp.m08_sources.register")


class SourceNotRegistered(KpError):
    """The source id has no row in the licence register."""

    def __init__(self, source_id: str) -> None:
        super().__init__(
            "POLICY_DENIED",
            f'Source "{source_id}" is not in the licence register',
            {"source_id": source_id, "reason": "not_registered"},
        )
        self.source_id = source_id


class SourceNotActive(KpError):
    """The source is registered but disabled or prohibited."""

    def __init__(self, source_id: str, status: str) -> None:
        super().__init__(
            "POLICY_DENIED",
            f'Source "{source_id}" is {status} and may not be used',
            {"source_id": source_id, "reason": status},
        )
        self.source_id = source_id
        self.status = status


@dataclass(frozen=True)
class SourceEntry:
    id: str
    source_type: SourceType
    can_store: bool
    can_display: bool
    can_export: bool
    retention_days: int | None
    attribution_text: str
    personal_data_class: PersonalDataClass
    allowed_regions: tuple[str, ...]
    status: SourceStatus
    notes: str | None = None
    domains: tuple[str, ...] = field(default=())

    @property
    def is_active(self) -> bool:
        return self.status == "active" and self.id not in PROHIBITED_SOURCE_IDS

    def allows_region(self, region: str | None) -> bool:
        """True when data about subjects in ``region`` (ISO 3166-1 alpha-2) may come from here.

        ``None`` (region unknown) is allowed only for sources open to all regions.
        """
        if ALL_REGIONS in self.allowed_regions:
            return True
        if region is None:
            return False
        return region.strip().upper() in self.allowed_regions


def validate_entry(raw: Mapping[str, Any]) -> SourceEntry:
    """Validates one register row (from YAML or the database) and returns a SourceEntry."""
    if not isinstance(raw, Mapping):
        raise KpError("VALIDATION", "source entry must be a mapping")
    sid = raw.get("id")
    where = f"source {sid!r}"
    if not isinstance(sid, str) or not SOURCE_ID_RE.match(sid):
        raise KpError("VALIDATION", f"{where}: id must match {SOURCE_ID_RE.pattern}")

    def _bool(key: str) -> bool:
        v = raw.get(key)
        if not isinstance(v, bool):
            raise KpError("VALIDATION", f"{where}: {key} must be a boolean", {"source_id": sid, "field": key})
        return v

    def _choice(key: str, allowed: Sequence[str]) -> str:
        v = raw.get(key)
        if v not in allowed:
            raise KpError("VALIDATION", f"{where}: {key} must be one of {', '.join(allowed)}",
                          {"source_id": sid, "field": key})
        return str(v)

    source_type = _choice("source_type", SOURCE_TYPES)
    can_store, can_display, can_export = _bool("can_store"), _bool("can_display"), _bool("can_export")
    retention = raw.get("retention_days")
    if retention is not None and (isinstance(retention, bool) or not isinstance(retention, int)
                                  or not 1 <= retention <= 36500):
        raise KpError("VALIDATION", f"{where}: retention_days must be null or an integer in 1..36500")
    attribution = raw.get("attribution_text")
    if not isinstance(attribution, str) or not 1 <= len(attribution.strip()) <= 500:
        raise KpError("VALIDATION", f"{where}: attribution_text must be 1..500 characters")
    pdc = _choice("personal_data_class", PERSONAL_DATA_CLASSES)
    regions_raw = raw.get("allowed_regions")
    if regions_raw is None or isinstance(regions_raw, (str, bytes)) or not isinstance(regions_raw, Iterable):
        raise KpError("VALIDATION", f"{where}: allowed_regions must be a list")
    regions: list[str] = []
    for r in regions_raw:
        if r == ALL_REGIONS:
            regions.append(ALL_REGIONS)
        elif isinstance(r, str) and _REGION_RE.match(r.strip().upper()):
            regions.append(r.strip().upper())
        else:
            raise KpError("VALIDATION", f"{where}: allowed_regions entries must be '*' or ISO alpha-2 codes")
    status = _choice("status", SOURCE_STATUSES)
    if status == "prohibited" and (can_store or can_display or can_export):
        raise KpError("VALIDATION", f"{where}: a prohibited source cannot grant store/display/export rights")
    if can_export and not can_display:
        raise KpError("VALIDATION", f"{where}: can_export requires can_display")
    if sid in PROHIBITED_SOURCE_IDS and status != "prohibited":
        raise KpError("VALIDATION", f"{where}: this source is permanently prohibited")
    notes = raw.get("notes")
    if notes is not None and not isinstance(notes, str):
        raise KpError("VALIDATION", f"{where}: notes must be text")
    domains_raw = raw.get("domains") or ()
    if isinstance(domains_raw, (str, bytes)) or not all(isinstance(d, str) and d for d in domains_raw):
        raise KpError("VALIDATION", f"{where}: domains must be a list of host names")
    domains = tuple(d.strip().lower() for d in domains_raw)
    if domains and status != "prohibited":
        raise KpError("VALIDATION", f"{where}: domains may only be listed for prohibited sources")
    return SourceEntry(
        id=sid,
        source_type=source_type,  # type: ignore[arg-type]
        can_store=can_store,
        can_display=can_display,
        can_export=can_export,
        retention_days=retention,
        attribution_text=attribution.strip(),
        personal_data_class=pdc,  # type: ignore[arg-type]
        allowed_regions=tuple(regions),
        status=status,  # type: ignore[arg-type]
        notes=notes,
        domains=domains,
    )


def default_register_path() -> Path:
    """<repo>/config/sources.yaml (py/kp/m08_sources/register.py → parents[3] is the repo root)."""
    return Path(__file__).resolve().parents[3] / "config" / "sources.yaml"


def load_register_file(path: str | Path | None = None) -> list[SourceEntry]:
    """Parses and validates config/sources.yaml. Duplicate ids are rejected."""
    import yaml

    p = Path(path) if path is not None else default_register_path()
    try:
        doc = yaml.safe_load(p.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise KpError("INTERNAL", f"Source register file not found: {p}") from e
    if not isinstance(doc, Mapping) or not isinstance(doc.get("sources"), list):
        raise KpError("VALIDATION", f"{p}: expected a top-level 'sources' list")
    entries = [validate_entry(row) for row in doc["sources"]]
    seen: set[str] = set()
    for e in entries:
        if e.id in seen:
            raise KpError("VALIDATION", f"{p}: duplicate source id {e.id!r}")
        seen.add(e.id)
    return entries


# ---- database-backed lookup ----------------------------------------------------------------

SourceLoader = Callable[[str], "Mapping[str, Any] | None"]

_SELECT_SOURCE = (
    "select id, source_type, can_store, can_display, can_export, retention_days, attribution_text, "
    "personal_data_class, allowed_regions, status, notes from knowledge.source where id = %s"
)
_SELECT_ALL = (
    "select id, source_type, can_store, can_display, can_export, retention_days, attribution_text, "
    "personal_data_class, allowed_regions, status, notes from knowledge.source order by id"
)


def _db_loader(source_id: str) -> Mapping[str, Any] | None:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(get_secret("DATABASE_URL"), autocommit=True, row_factory=dict_row) as conn:
        return conn.execute(_SELECT_SOURCE, (source_id,)).fetchone()


def list_register_rows(conn: Any) -> list[SourceEntry]:
    """All register rows (any status) using the caller's psycopg connection."""
    from psycopg.rows import dict_row

    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(_SELECT_ALL)
        return [validate_entry(dict(r)) for r in cur.fetchall()]


_loader: SourceLoader = _db_loader
_cache: dict[str, tuple[float, SourceEntry | None]] = {}
_cache_lock = threading.Lock()


def set_source_loader_for_testing(loader: SourceLoader | None) -> None:
    """Replaces the database lookup (``None`` restores it) and clears the cache."""
    global _loader
    _loader = loader or _db_loader
    clear_source_cache()


def register_entries_loader(entries: Iterable[SourceEntry]) -> SourceLoader:
    """Builds a loader over in-memory entries (tests, offline tools)."""
    by_id = {e.id: e for e in entries}

    def load(source_id: str) -> Mapping[str, Any] | None:
        e = by_id.get(source_id)
        if e is None:
            return None
        return {
            "id": e.id, "source_type": e.source_type, "can_store": e.can_store, "can_display": e.can_display,
            "can_export": e.can_export, "retention_days": e.retention_days, "attribution_text": e.attribution_text,
            "personal_data_class": e.personal_data_class, "allowed_regions": list(e.allowed_regions),
            "status": e.status, "notes": e.notes, "domains": list(e.domains),
        }

    return load


def clear_source_cache() -> None:
    with _cache_lock:
        _cache.clear()


def lookup_source(source_id: str) -> SourceEntry | None:
    """Returns the entry in any status, or None when unregistered. Cached for CACHE_TTL_S."""
    if not isinstance(source_id, str) or not SOURCE_ID_RE.match(source_id):
        return None
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(source_id)
        if hit is not None and now - hit[0] < CACHE_TTL_S:
            return hit[1]
    row = _loader(source_id)
    entry = validate_entry(dict(row)) if row is not None else None
    with _cache_lock:
        _cache[source_id] = (now, entry)
    return entry


def get_source(source_id: str) -> SourceEntry:
    """IF-08a. Raises SourceNotRegistered / SourceNotActive."""
    entry = lookup_source(source_id)
    if entry is None:
        _log.warning("source lookup refused: not registered", extra={"source_id": source_id})
        raise SourceNotRegistered(source_id)
    if not entry.is_active:
        status = "prohibited" if entry.id in PROHIBITED_SOURCE_IDS else entry.status
        _log.warning("source lookup refused: not active", extra={"source_id": source_id, "status": status})
        raise SourceNotActive(source_id, status)
    return entry


def is_prohibited_host(host: str) -> bool:
    """True for a prohibited host or any of its subdomains (www.linkedin.com, in.linkedin.com …)."""
    h = host.strip().lower().rstrip(".")
    return any(h == d or h.endswith("." + d) for d in PROHIBITED_HOSTS)
