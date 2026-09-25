"""M08 connector framework (IF-08b).

    class MyConnector(Connector):
        source_id = "registry.gb.ch"
        rate_class = "registry.gb.ch"
        def fetch(self, req): ...          # yields RawItem
        def parse(self, ref): ...          # yields Record (built with self.record(...))

``Connector.__init__`` looks the source up in the licence register and **refuses to construct**
when the entry is missing, disabled or prohibited. ``run(req)`` does fetch → land → parse,
records vendor cost and checks the vendor budget flag.

Licence enforcement (enabling REQ-033 attribution and REQ-048 export rights): every Record that
leaves ``run`` carries the source's attribution text and ``can_display`` / ``can_export`` /
``personal_data_class`` exactly as the register grants them — a parser cannot widen them — and
records about subjects outside ``allowed_regions`` are dropped.
"""
from __future__ import annotations

import dataclasses
import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, ClassVar, Iterable, Iterator, Mapping

from kp.m01_platform import (
    KpError,
    assert_vendor_budget,
    get_logger,
    is_budget_exceeded,
    new_id,
    record_cost,
    span,
)

from .http import HttpResponse, ProhibitedHost, RobotsDisallowed, http_fetch
from .register import PersonalDataClass, SourceEntry, SourceType, get_source
from .storage import (
    DEFAULT_LOCK_DAYS,
    DbRawIndex,
    RawIndex,
    RawObjectRow,
    RawStore,
    S3RawStore,
    expiry_for,
    raw_key,
)

BUDGET_CHECK_EVERY = 100  # items between budget-flag re-checks during a run [tunable]

_log = get_logger("kp.m08_sources.connector")


class SourceStorageForbidden(KpError):
    """land() was called for a source whose register entry has can_store = false."""

    def __init__(self, source_id: str) -> None:
        super().__init__("POLICY_DENIED", f'Source "{source_id}" may not be stored (can_store = false)',
                         {"source_id": source_id, "reason": "can_store_false"})


@dataclass(frozen=True)
class FetchRequest:
    """What to fetch. Connectors interpret ``params``; ``since`` bounds incremental pulls."""

    params: Mapping[str, Any] = field(default_factory=dict)
    since: datetime | None = None
    limit: int | None = None
    correlation_id: str | None = None


@dataclass(frozen=True)
class RawItem:
    body: bytes
    content_type: str = "application/octet-stream"
    url: str | None = None
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    # Vendor cost of obtaining this item, in micro-INR (0 for free sources).
    cost_micros_inr: int = 0
    meta: Mapping[str, Any] = field(default_factory=dict)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.body).hexdigest()


@dataclass(frozen=True)
class RawRef:
    """A landed raw object (``raw_object_id``/``s3_key`` set) or, for can_store = false sources,
    an in-memory reference (``item`` set, nothing persisted)."""

    source_id: str
    sha256: str
    fetched_at: datetime
    url: str | None
    bytes: int
    content_type: str
    raw_object_id: str | None = None
    s3_key: str | None = None
    expires_at: datetime | None = None
    item: RawItem | None = None
    meta: Mapping[str, Any] = field(default_factory=dict)

    @property
    def stored(self) -> bool:
        return self.raw_object_id is not None


@dataclass(frozen=True)
class Record:
    """One parsed fact with its provenance and the licence terms it travels under."""

    attribute: str
    value: Any
    subject: Mapping[str, Any]
    source_id: str
    source_type: SourceType
    source_ref: Mapping[str, Any]
    observed_at: datetime
    attribution_text: str
    can_display: bool
    can_export: bool
    personal_data_class: PersonalDataClass
    region: str | None = None
    polarity: str = "positive"
    confidence: float = 1.0


RecordSink = Callable[[Record], None]


@dataclass
class RunStats:
    source_id: str
    fetched: int = 0
    landed: int = 0
    deduplicated: int = 0
    in_memory: int = 0
    parsed: int = 0
    records: int = 0
    skipped: int = 0
    region_blocked: int = 0
    errors: int = 0
    cost_micros_inr: int = 0
    budget_stopped: bool = False
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None

    def as_dict(self) -> dict[str, Any]:
        d = dataclasses.asdict(self)
        d["started_at"] = self.started_at.isoformat()
        d["finished_at"] = self.finished_at.isoformat() if self.finished_at else None
        return d


class Connector(ABC):
    source_id: ClassVar[str]
    rate_class: ClassVar[str]
    # Vendor name for cost metrics and the budget flag; defaults to the source id.
    vendor: ClassVar[str | None] = None

    def __init__(
        self,
        *,
        sink: RecordSink | None = None,
        store: RawStore | None = None,
        index: RawIndex | None = None,
    ) -> None:
        sid = getattr(type(self), "source_id", None)
        if not isinstance(sid, str) or not sid:
            raise KpError("INTERNAL", f"{type(self).__name__} must set the class attribute source_id")
        if not isinstance(getattr(type(self), "rate_class", None), str):
            raise KpError("INTERNAL", f"{type(self).__name__} must set the class attribute rate_class")
        # Refuses to construct when the entry is missing or not active.
        self.source: SourceEntry = get_source(sid)
        self._sink = sink
        self._store = store
        self._index = index
        self._stats: RunStats | None = None

    # ---- to implement ----------------------------------------------------------------------

    @abstractmethod
    def fetch(self, req: FetchRequest) -> Iterable[RawItem]: ...

    @abstractmethod
    def parse(self, ref: RawRef) -> Iterable[Record]:
        """Parse one raw payload. Read its bytes with ``self.body_of(ref)``; build records with
        ``self.record(...)``."""

    # ---- helpers for implementations -------------------------------------------------------

    @property
    def vendor_name(self) -> str:
        return type(self).vendor or self.source.id

    def http_fetch(self, url: str, **kwargs: Any) -> HttpResponse:
        """Robots-checked, identified fetch. Disallowed URLs are counted in RunStats.skipped."""
        return http_fetch(url, on_skip=self._count_skip, **kwargs)

    def _count_skip(self, _url: str) -> None:
        if self._stats is not None:
            self._stats.skipped += 1

    def store(self) -> RawStore:
        if self._store is None:
            self._store = S3RawStore()
        return self._store

    def index(self) -> RawIndex:
        if self._index is None:
            self._index = DbRawIndex()
        return self._index

    def body_of(self, ref: RawRef) -> bytes:
        if ref.item is not None:
            return ref.item.body
        if ref.s3_key is None:
            raise KpError("INTERNAL", "RawRef has neither an in-memory item nor an s3_key")
        return self.store().get(ref.s3_key)

    def record(
        self,
        ref: RawRef,
        *,
        attribute: str,
        value: Any,
        subject: Mapping[str, Any],
        observed_at: datetime | None = None,
        region: str | None = None,
        polarity: str = "positive",
        confidence: float = 1.0,
        extra_ref: Mapping[str, Any] | None = None,
    ) -> Record:
        """Builds a Record stamped with this source's licence terms and provenance."""
        if polarity not in ("positive", "negative"):
            raise KpError("VALIDATION", "polarity must be 'positive' or 'negative'")
        if not 0.0 <= confidence <= 1.0:
            raise KpError("VALIDATION", "confidence must be between 0 and 1")
        src_ref: dict[str, Any] = {"sha256": ref.sha256, "url": ref.url}
        if ref.raw_object_id is not None:
            src_ref["raw_object_id"] = ref.raw_object_id
            src_ref["s3_key"] = ref.s3_key
        if extra_ref:
            src_ref.update(extra_ref)
        return Record(
            attribute=attribute,
            value=value,
            subject=dict(subject),
            source_id=self.source.id,
            source_type=self.source.source_type,
            source_ref=src_ref,
            observed_at=observed_at or ref.fetched_at,
            attribution_text=self.source.attribution_text,
            can_display=self.source.can_display,
            can_export=self.source.can_export,
            personal_data_class=self.source.personal_data_class,
            region=region.strip().upper() if region else None,
            polarity=polarity,
            confidence=confidence,
        )

    # ---- landing ---------------------------------------------------------------------------

    def in_memory_ref(self, item: RawItem) -> RawRef:
        return RawRef(
            source_id=self.source.id, sha256=item.sha256, fetched_at=item.fetched_at, url=item.url,
            bytes=len(item.body), content_type=item.content_type, item=item, meta=item.meta,
        )

    def land(self, item: RawItem) -> RawRef:
        """Writes s3://raw/<source_id>/<yyyy>/<mm>/<dd>/<sha256>; idempotent on sha256.

        Raises SourceStorageForbidden when the source has can_store = false.
        """
        if not self.source.can_store:
            raise SourceStorageForbidden(self.source.id)
        sha = item.sha256
        existing = self.index().find(self.source.id, sha)
        if existing is not None:
            if self._stats is not None:
                self._stats.deduplicated += 1
            return self._ref_from_row(existing, item)
        fetched_at = item.fetched_at if item.fetched_at.tzinfo else item.fetched_at.replace(tzinfo=timezone.utc)
        key = raw_key(self.source.id, sha, fetched_at)
        expires_at = expiry_for(self.source.retention_days, fetched_at)
        retain_until = expires_at or expiry_for(DEFAULT_LOCK_DAYS, fetched_at)
        assert retain_until is not None
        wrote = self.store().put_if_absent(
            key, item.body, content_type=item.content_type, sha256=sha, retain_until=retain_until,
            metadata={"source-id": self.source.id, "sha256": sha},
        )
        row = self.index().insert(RawObjectRow(
            id=new_id(), source_id=self.source.id, s3_key=key, sha256=sha, fetched_at=fetched_at,
            url=item.url, bytes=len(item.body), expires_at=expires_at,
        ))
        if self._stats is not None:
            if wrote and row.s3_key == key:
                self._stats.landed += 1
            else:
                self._stats.deduplicated += 1
        return self._ref_from_row(row, item)

    def _ref_from_row(self, row: RawObjectRow, item: RawItem) -> RawRef:
        return RawRef(
            source_id=row.source_id, sha256=row.sha256, fetched_at=row.fetched_at, url=row.url, bytes=row.bytes,
            content_type=item.content_type, raw_object_id=row.id, s3_key=row.s3_key, expires_at=row.expires_at,
            meta=item.meta,
        )

    # ---- run -------------------------------------------------------------------------------

    def _licensed(self, rec: Record) -> Record | None:
        """Clamps a record to the register's terms; None when its region is not allowed."""
        if not self.source.allows_region(rec.region):
            return None
        return dataclasses.replace(
            rec,
            source_id=self.source.id,
            source_type=self.source.source_type,
            attribution_text=self.source.attribution_text,
            can_display=rec.can_display and self.source.can_display,
            can_export=rec.can_export and self.source.can_export and self.source.can_display,
            personal_data_class=self.source.personal_data_class,
        )

    def _budget_ok(self) -> bool:
        try:
            return not is_budget_exceeded(self.vendor_name)
        except Exception:
            _log.exception("budget flag check failed; continuing", extra={"vendor": self.vendor_name})
            return True

    def run(self, req: FetchRequest, sink: RecordSink | None = None) -> RunStats:
        """fetch → land → parse; records cost; checks the budget flag."""
        out = sink or self._sink
        if out is None:
            raise KpError("INTERNAL", f"{type(self).__name__}.run() needs a record sink",
                          {"source_id": self.source.id})
        # Re-check the register: the source may have been disabled since construction.
        self.source = get_source(self.source.id)
        assert_vendor_budget(self.vendor_name)
        stats = RunStats(source_id=self.source.id)
        self._stats = stats
        try:
            with span("m08.connector.run", {"source_id": self.source.id, "rate_class": type(self).rate_class}):
                self._run_items(req, out, stats)
        finally:
            self._stats = None
            stats.finished_at = datetime.now(timezone.utc)
            if stats.fetched or stats.cost_micros_inr:
                record_cost(
                    vendor=self.vendor_name, op="fetch", units=stats.fetched, cost_micros_inr=stats.cost_micros_inr,
                    job_type="m08.connector.run", correlation_id=req.correlation_id,
                )
            _log.info("connector run finished", extra={"stats": stats.as_dict()})
        return stats

    def _run_items(self, req: FetchRequest, out: RecordSink, stats: RunStats) -> None:
        items: Iterator[RawItem] = iter(self.fetch(req))
        while True:
            if req.limit is not None and stats.fetched >= req.limit:
                break
            if stats.fetched and stats.fetched % BUDGET_CHECK_EVERY == 0 and not self._budget_ok():
                stats.budget_stopped = True
                _log.warning("vendor budget exhausted; stopping run", extra={"vendor": self.vendor_name})
                break
            try:
                item = next(items)
            except StopIteration:
                break
            except (RobotsDisallowed, ProhibitedHost):
                # Already counted in stats.skipped by the helper; the fetch generator is finished.
                break
            stats.fetched += 1
            if isinstance(item.cost_micros_inr, int) and item.cost_micros_inr > 0:
                stats.cost_micros_inr += item.cost_micros_inr
            try:
                if self.source.can_store:
                    ref = self.land(item)
                else:
                    ref = self.in_memory_ref(item)  # process in memory only; nothing persisted
                    stats.in_memory += 1
                for rec in self.parse(ref):
                    licensed = self._licensed(rec)
                    if licensed is None:
                        stats.region_blocked += 1
                        continue
                    out(licensed)
                    stats.records += 1
                stats.parsed += 1
            except (RobotsDisallowed, ProhibitedHost):
                continue  # counted by the helper
            except KpError as e:
                if e.code == "UPSTREAM_UNAVAILABLE" and e.details and e.details.get("reason") == "budget_exceeded":
                    stats.budget_stopped = True
                    break
                stats.errors += 1
                _log.warning("item failed", extra={"source_id": self.source.id, "url": item.url, "code": e.code})
            except Exception:
                stats.errors += 1
                _log.exception("item failed", extra={"source_id": self.source.id, "url": item.url})
