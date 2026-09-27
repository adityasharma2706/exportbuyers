"""M21 data model: constants, ISO batch weeks, the landed bill-of-lading row, aggregates, job payloads
and run results."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from kp.m01_platform import KpError

# ---- constants ----------------------------------------------------------------------------------

INGEST_JOB = "m21.ingest_week"
INGEST_SCHEDULE = "m21.ingest-weekly"
QUEUE = "knowledge"
RATE_CLASS = "customs_us"
DEFAULT_CRON = "0 6 * * 2"         # Tuesdays 06:00 UTC: vendors usually publish the prior week by Monday [tunable]
MAX_ATTEMPTS = 5

PRODUCER = "m21"
AGG_V = 1
PRODUCER_VERSION = f"customs-us-agg-v{AGG_V}"
SOURCE_ID_PREFIX = "customs.us."   # the register id is customs.us.<vendor>
ACTIVITY_ATTRIBUTE = "activity_aggregate"
COUNTRY = "US"

HS_CONFIDENCE_MIN = 0.6            # inferred headings below this are dropped from aggregates (LLD M21)
DECLARED_HS_CONFIDENCE = 1.0
WINDOW_DAYS = 365                  # "last 12 months"
LAST_SEEN_WINDOW_DAYS = 730        # consignees quiet for 12–24 months get a zero aggregate (see deviations)
TOP_SUPPLIERS = 5
BASE_AGG_CONFIDENCE = 0.95         # customs aggregates are strong evidence; scaled by HS certainty
CHUNK_ROWS = 50_000                # BOL rows per Parquet part file / inference batch [tunable]

_VENDOR_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
_WEEK_RE = re.compile(r"^(\d{4})-W?(\d{2})$")
_CC_RE = re.compile(r"^[A-Z]{2}$")
_HEADING_RE = re.compile(r"^\d{4}$")


def source_id_for(vendor: str) -> str:
    v = (vendor or "").strip().lower()
    if not _VENDOR_RE.match(v):
        raise KpError("VALIDATION", "vendor must be a lower-case identifier", {"vendor": vendor})
    return f"{SOURCE_ID_PREFIX}{v}"


# ---- ISO weeks ----------------------------------------------------------------------------------

@dataclass(frozen=True, order=True)
class IsoWeek:
    """An ISO-8601 week; the batch unit of the vendor feed. ``str()`` is ``YYYY-WW`` (the partition name)."""

    year: int
    week: int

    def __post_init__(self) -> None:
        try:
            date.fromisocalendar(self.year, self.week, 1)
        except ValueError as e:
            raise KpError("VALIDATION", f"Invalid ISO week {self.year}-{self.week:02d}") from e

    @classmethod
    def parse(cls, s: str) -> IsoWeek:
        m = _WEEK_RE.match((s or "").strip().upper())
        if not m:
            raise KpError("VALIDATION", "week must look like YYYY-WW", {"week": s})
        return cls(int(m.group(1)), int(m.group(2)))

    @classmethod
    def of(cls, d: date | datetime) -> IsoWeek:
        if isinstance(d, datetime):
            d = d.astimezone(timezone.utc).date() if d.tzinfo else d.date()
        y, w, _ = d.isocalendar()
        return cls(y, w)

    @classmethod
    def last_complete(cls, now: datetime | None = None) -> IsoWeek:
        """The most recent week that has fully ended (UTC)."""
        n = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        return cls.of(n.date() - timedelta(days=7))

    @property
    def start(self) -> date:
        return date.fromisocalendar(self.year, self.week, 1)

    @property
    def end(self) -> date:
        """Sunday, the last day of the week."""
        return date.fromisocalendar(self.year, self.week, 7)

    def label(self) -> str:
        """``YYYY-Www`` for provenance (``source_ref.batch_week``)."""
        return f"{self.year}-W{self.week:02d}"

    def __str__(self) -> str:
        return f"{self.year}-{self.week:02d}"


# ---- the landed row ------------------------------------------------------------------------------

HsMethod = Literal["declared", "keyword", "vector", "keyword+vector", "none"]

# Parquet column order. The first ten are the LLD M21 schema; the rest are derived at landing
# (heading inference and grouping keys) so the 12-month aggregation never has to redo them.
LLD_COLUMNS: tuple[str, ...] = (
    "bol_id", "arrival_date", "consignee_name", "consignee_addr", "shipper_name", "shipper_country",
    "hs_code", "description", "weight_kg", "teu",
)
DERIVED_COLUMNS: tuple[str, ...] = (
    "hs_heading", "hs_confidence", "hs_method", "consignee_key", "shipper_key", "batch_week",
)
PARQUET_COLUMNS: tuple[str, ...] = LLD_COLUMNS + DERIVED_COLUMNS


@dataclass
class BolRow:
    bol_id: str
    arrival_date: date
    consignee_name: str
    consignee_addr: str | None = None
    shipper_name: str | None = None
    shipper_country: str | None = None
    hs_code: str | None = None
    description: str | None = None
    weight_kg: float | None = None
    teu: float | None = None
    # derived
    hs_heading: str | None = None
    hs_confidence: float | None = None
    hs_method: HsMethod = "none"
    consignee_key: str = ""
    shipper_key: str = ""
    batch_week: str = ""

    def as_record(self) -> dict[str, Any]:
        return {c: getattr(self, c) for c in PARQUET_COLUMNS}

    @classmethod
    def from_value(cls, v: dict[str, Any]) -> BolRow:
        d = dict(v)
        ad = d.get("arrival_date")
        if isinstance(ad, str):
            d["arrival_date"] = date.fromisoformat(ad[:10])
        return cls(**{k: d.get(k) for k in LLD_COLUMNS})

    def as_value(self) -> dict[str, Any]:
        """JSON-safe LLD columns (carried inside an in-memory M08 Record; never written to M09)."""
        out = {c: getattr(self, c) for c in LLD_COLUMNS}
        out["arrival_date"] = self.arrival_date.isoformat()
        return out


# ---- aggregates ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class Supplier:
    name: str
    country: str | None
    shipments: int

    def as_value(self) -> dict[str, Any]:
        return {"name": self.name, "country": self.country, "shipments": self.shipments}


@dataclass
class HeadingAggregate:
    """One consignee × HS heading (LLD M21 aggregation)."""

    hs_heading: str
    shipments_12m: int
    volume_kg_12m: float
    teu_12m: float
    origins: dict[str, int]
    top_suppliers: list[Supplier]
    last_seen: date
    row_count: int                 # BOL rows in the 24-month window behind this aggregate
    mean_hs_confidence: float

    def value(self, window_start: date, window_end: date) -> dict[str, Any]:
        return {
            "hs_heading": self.hs_heading,
            "shipments_12m": int(self.shipments_12m),
            "volume_kg_12m": round(float(self.volume_kg_12m), 3),
            "teu_12m": round(float(self.teu_12m), 3),
            "origins": {k: int(v) for k, v in sorted(self.origins.items())},
            "top_suppliers": [s.as_value() for s in self.top_suppliers],
            "last_seen": self.last_seen.isoformat(),
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
        }

    def confidence(self) -> float:
        return round(BASE_AGG_CONFIDENCE * max(0.0, min(1.0, self.mean_hs_confidence)), 4)


@dataclass
class ConsigneeGroup:
    consignee_key: str
    name: str
    address: str | None
    headings: list[HeadingAggregate] = field(default_factory=list)


# ---- job payload --------------------------------------------------------------------------------

class IngestWeekPayload(BaseModel):
    """``m21.ingest_week {week?, vendor?, skipFetch?}``. Without ``week`` the last complete week is used;
    without ``vendor`` the configured vendor is used. ``skipFetch`` re-runs only the aggregation."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    week: str | None = None
    vendor: str | None = Field(default=None, max_length=63)
    skip_fetch: bool = Field(default=False, alias="skipFetch")

    @field_validator("week")
    @classmethod
    def _w(cls, v: str | None) -> str | None:
        if v is None:
            return None
        try:
            return str(IsoWeek.parse(v))
        except KpError as e:
            raise ValueError(e.message) from e

    @field_validator("vendor")
    @classmethod
    def _v(cls, v: str | None) -> str | None:
        if v is None:
            return None
        try:
            source_id_for(v)
        except KpError as e:
            raise ValueError(e.message) from e
        return v.strip().lower()


# ---- run result ---------------------------------------------------------------------------------

@dataclass
class IngestRun:
    run_id: str
    week: str
    source_id: str
    files: int = 0
    rows_landed: int = 0
    rows_rejected: int = 0
    hs_declared: int = 0
    hs_inferred: int = 0
    hs_dropped: int = 0
    parquet_parts: list[str] = field(default_factory=list)
    consignee_groups: int = 0
    companies_resolved: int = 0
    companies_created: int = 0
    companies_suppressed: int = 0
    assertions_written: int = 0
    assertions_suppressed: int = 0
    group_errors: int = 0
    recompute_job_id: str | None = None

    def summary(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if k != "parquet_parts"} | {"parts": len(self.parquet_parts)}


def valid_country(cc: Any) -> str | None:
    s = str(cc or "").strip().upper()
    return s if _CC_RE.match(s) else None


def valid_heading(h: Any) -> str | None:
    s = str(h or "").strip()
    return s if _HEADING_RE.match(s) else None
