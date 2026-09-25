"""M17 screener: ``screen_company`` and ``screen_name`` (REQ-029; feeds the REQ-027 sanctions check).

screen_company(company_id)
  1. Resolve the company (M09, merges followed), normalise its name.
  2. Candidates from the trigram prefilter; score and classify (matching.py).
  3. Apply the stored operator decision: ``confirmed`` → hit while any decided entry still matches;
     ``cleared`` → clear until the matched entries change (a new entry matches, or a decided entry
     was updated or delisted after the decision).
  4. Write knowledge.sanctions_screen.
  5. When block (= hit or possible) differs from the previous screen: write a ``sanctions_flag``
     assertion {block} through M09 IF-09a and emit EV-03 ``sanctions.flag_changed``.
     ``possible`` sets block = true while the review item is pending [assumption: fail safe].
  6. ``possible`` with a new set of matched entries → the serving plane files
     ``sanctions.possible_match`` (M11, dedupe key = company id) via job ``m17.file_possible_match``.
All writes share the caller's transaction.

screen_name(name, country) is ad hoc: it stores the screen under 'adhoc:<sha256>' and never writes
to the catalogue.
"""
from __future__ import annotations

import hashlib
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, ContextManager, Iterator, Mapping, Protocol

from kp.m01_platform import KpError, get_logger, get_secret, span
from kp.m02_queue import emit, enqueue
from kp.m09_evidence import (
    EV_SANCTIONS_FLAG_CHANGED,
    AssertionIn,
    CompanyNotFound,
    get_company,
    resolve_company_id,
    write_assertion,
)

from .matching import Evaluation, evaluate
from .models import LIST_KEYS, LIST_SOURCE, ScreenResult, ScreenRow, utcnow
from .normalise import normalise_name
from .store import PgSanctionsStore, SanctionsStore

_log = get_logger("kp.m17_sanctions.screener")

MATCHER_VERSION = "1"
PRODUCER = "m17.screen"
FILE_POSSIBLE_MATCH_JOB = "m17.file_possible_match"   # serving queue; handled by apps/web m17_sanctions
POSSIBLE_MATCH_TYPE = "sanctions.possible_match"
BLOCKING = ("hit", "possible")
MAX_NAME_LEN = 500


class Outbox(Protocol):
    """Where events and cross-plane jobs go; the Pg implementation writes in the caller's tx."""

    def emit(self, type: str, payload: Mapping[str, Any]) -> str: ...
    def enqueue(self, type: str, queue: str, payload: Mapping[str, Any], idempotency_key: str) -> str: ...


class PgOutbox:
    def __init__(self, conn: Any) -> None:
        self.conn = conn

    def emit(self, type: str, payload: Mapping[str, Any]) -> str:
        return emit(self.conn, type, dict(payload))

    def enqueue(self, type: str, queue: str, payload: Mapping[str, Any], idempotency_key: str) -> str:
        return enqueue(self.conn, type=type, queue=queue, payload=dict(payload),  # type: ignore[arg-type]
                       idempotency_key=idempotency_key)


@dataclass
class MemoryOutbox:
    events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    jobs: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)

    def emit(self, type: str, payload: Mapping[str, Any]) -> str:
        self.events.append((type, dict(payload)))
        return f"evt-{len(self.events)}"

    def enqueue(self, type: str, queue: str, payload: Mapping[str, Any], idempotency_key: str) -> str:
        self.jobs.setdefault((type, idempotency_key), {"queue": queue, "payload": dict(payload)})
        return f"job-{len(self.jobs)}"


# ---- connections ---------------------------------------------------------------------------------

ConnectionFactory = Callable[[], ContextManager[Any]]


def _default_connect() -> ContextManager[Any]:
    import psycopg

    return psycopg.connect(get_secret("DATABASE_URL"))


_connect: ConnectionFactory = _default_connect


def set_connection_factory(fn: ConnectionFactory | None) -> None:
    """Replaces how M17 opens a connection when no ``tx`` is passed (``None`` restores the default)."""
    global _connect
    _connect = fn or _default_connect


@dataclass
class ScreenContext:
    """Everything one screen writes through: the transaction (psycopg connection or, in tests, an
    M09 EvidenceRepo), the sanctions store and the outbox."""

    tx: Any
    store: SanctionsStore
    outbox: Outbox


@contextmanager
def open_context(tx: Any = None, *, store: SanctionsStore | None = None,
                 outbox: Outbox | None = None) -> Iterator[ScreenContext]:
    if tx is not None:
        yield ScreenContext(tx=tx, store=store or PgSanctionsStore(tx), outbox=outbox or PgOutbox(tx))
        return
    with _connect() as conn:
        yield ScreenContext(tx=conn, store=store or PgSanctionsStore(conn), outbox=outbox or PgOutbox(conn))


# ---- helpers ---------------------------------------------------------------------------------

def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def input_hash(name_norm: str, country: str | None) -> str:
    return _sha(f"v{MATCHER_VERSION}|{name_norm}|{(country or '').upper()}")


def adhoc_key(name: str, country: str | None) -> str:
    return "adhoc:" + _sha(f"{normalise_name(name)}|{(country or '').upper()}")


def _validate_country(country: str | None) -> str | None:
    if country is None or country == "":
        return None
    c = country.strip().upper()
    if len(c) != 2 or not c.isalpha():
        raise KpError("VALIDATION", "country must be an ISO 3166-1 alpha-2 code")
    return c


def _result_of(row: ScreenRow, cached: bool) -> ScreenResult:
    return ScreenResult(subject_key=row.subject_key, result=row.result, raw_result=row.raw_result,  # type: ignore[arg-type]
                        best_score=max(0.0, float(row.best_score)), matched_entry_ids=list(row.matched_entry_ids),
                        list_versions=dict(row.list_versions), screened_at=row.screened_at,
                        decision=row.decision, cached=cached)  # type: ignore[arg-type]


def is_fresh(row: ScreenRow | None, store: SanctionsStore) -> bool:
    """A stored screen is current when it was taken after the latest list load."""
    if row is None:
        return False
    latest = store.latest_load_at()
    return latest is None or row.screened_at > latest


def _apply_decision(prev: ScreenRow | None, ev: Evaluation, store: SanctionsStore
                    ) -> tuple[str, str | None, datetime | None, list[str] | None]:
    """(result, decision, decided_at, decision_entry_ids) after applying a stored decision."""
    if prev is None or prev.decision is None or prev.decided_at is None:
        return ev.result, None, None, None
    decided = set(prev.decision_entry_ids or [])
    current = set(ev.matched_entry_ids)
    if prev.decision == "confirmed":
        if current & decided:
            return "hit", prev.decision, prev.decided_at, sorted(decided)
        return ev.result, None, None, None
    # cleared
    if not current <= decided:
        return ev.result, None, None, None
    for e in store.entries_by_ids(sorted(decided)):
        if not e.active or (e.updated_at is not None and e.updated_at > prev.decided_at):
            return ev.result, None, None, None
    return "clear", prev.decision, prev.decided_at, sorted(decided)


def _flag_source(ev: Evaluation, prev: ScreenRow | None, store: SanctionsStore) -> str:
    if ev.matches:
        return LIST_SOURCE[ev.matches[0].list]
    if prev is not None and prev.matched_entry_ids:
        lists = {e.list for e in store.entries_by_ids(prev.matched_entry_ids)}
        for k in LIST_KEYS:
            if k in lists:
                return LIST_SOURCE[k]
    loads = store.list_loads()
    for k in LIST_KEYS:
        if k in loads:
            return LIST_SOURCE[k]
    return LIST_SOURCE["ofac_sdn"]


def _matched_fingerprint(ids: list[str]) -> str:
    return _sha(",".join(sorted(ids)))[:32]


# ---- API -------------------------------------------------------------------------------------

def screen_company(company_id: Any, *, tx: Any = None, store: SanctionsStore | None = None,
                   outbox: Outbox | None = None, force: bool = False) -> ScreenResult:
    """Screens one canonical company. Without ``force`` a stored screen is reused when it is newer
    than the latest list load and the company's name and country have not changed."""
    with open_context(tx, store=store, outbox=outbox) as ctx, span("m17.screen_company"):
        return _screen_company(ctx, str(company_id), force=force)


def _screen_company(ctx: ScreenContext, company_id: str, *, force: bool) -> ScreenResult:
    cid = resolve_company_id(company_id, tx=ctx.tx)
    company = get_company(cid, tx=ctx.tx)
    if company is None:
        raise CompanyNotFound(cid)
    norm = normalise_name(company.display_name)
    country = (company.country or "").upper() or None
    ihash = input_hash(norm, country)
    prev = ctx.store.get_screen(cid)
    if not force and prev is not None and prev.input_hash == ihash and is_fresh(prev, ctx.store):
        return _result_of(prev, cached=True)

    ev = evaluate([norm], country, ctx.store.candidates([norm]))
    result, decision, decided_at, decision_ids = _apply_decision(prev, ev, ctx.store)
    now = utcnow()
    row = ScreenRow(subject_key=cid, result=result, raw_result=ev.result, matched_entry_ids=ev.matched_entry_ids,
                    best_score=ev.best_score, list_versions=ctx.store.list_versions(), input_hash=ihash,
                    screened_at=now, decision=decision, decided_at=decided_at, decision_entry_ids=decision_ids)
    ctx.store.put_screen(row)

    block = result in BLOCKING
    prev_block = prev is not None and prev.result in BLOCKING
    if block != prev_block:
        source_id = _flag_source(ev, prev, ctx.store)
        write_assertion(AssertionIn(
            subject_id=cid, attribute="sanctions_flag", value={"block": block, "result": result},
            source_id=source_id,
            source_ref={"producer": PRODUCER, "result": result, "raw_result": ev.result, "best_score": ev.best_score,
                        "matches": [m.as_dict() for m in ev.matches[:10]], "list_versions": row.list_versions,
                        "decision": decision, "screened_at": now.isoformat()},
            observed_at=now, confidence=1.0 if result != "possible" else round(min(1.0, ev.best_score / 100.0), 4),
            producer=PRODUCER, producer_version=MATCHER_VERSION,
        ), tx=ctx.tx)
        ctx.outbox.emit(EV_SANCTIONS_FLAG_CHANGED, {"company_id": cid, "block": block})
        _log.info("sanctions flag changed", extra={"company_id": cid, "block": block, "result": result,
                                                   "best_score": ev.best_score})

    if result == "possible":
        prev_ids = sorted(prev.matched_entry_ids) if prev is not None and prev.result == "possible" else None
        if prev_ids != sorted(ev.matched_entry_ids):
            ctx.outbox.enqueue(
                FILE_POSSIBLE_MATCH_JOB, "serving",
                {"companyId": cid, "companyName": company.display_name, "country": country,
                 "bestScore": ev.best_score,
                 "matches": [{"entryId": m.entry_id, "list": m.list, "listUid": m.list_uid, "name": m.name,
                              "score": round(m.score, 2)} for m in ev.matches[:20]],
                 "listVersions": row.list_versions, "screenedAt": now.isoformat()},
                f"{cid}:{_matched_fingerprint(ev.matched_entry_ids)}",
            )
    res = _result_of(row, cached=False)
    res.matches = [m.as_dict() for m in ev.matches[:20]]
    return res


def screen_name(name: str, country: str | None = None, *, tx: Any = None,
                store: SanctionsStore | None = None) -> ScreenResult:
    """Ad-hoc screen of a name (no catalogue write). Stored under 'adhoc:<sha256>'."""
    if not isinstance(name, str) or not name.strip():
        raise KpError("VALIDATION", "name is required")
    if len(name) > MAX_NAME_LEN:
        raise KpError("VALIDATION", f"name must be at most {MAX_NAME_LEN} characters")
    c = _validate_country(country)
    norm = normalise_name(name)
    if not norm:
        raise KpError("VALIDATION", "name has no letters or digits")
    with open_context(tx, store=store, outbox=MemoryOutbox()) as ctx, span("m17.screen_name"):
        ev = evaluate([norm], c, ctx.store.candidates([norm]))
        row = ScreenRow(subject_key=adhoc_key(name, c), result=ev.result, raw_result=ev.result,
                        matched_entry_ids=ev.matched_entry_ids, best_score=ev.best_score,
                        list_versions=ctx.store.list_versions(), input_hash=input_hash(norm, c), screened_at=utcnow())
        ctx.store.put_screen(row)
        res = _result_of(row, cached=False)
        res.matches = [m.as_dict() for m in ev.matches[:20]]
        return res


def screen_company_for_rpc(company_id: Any, *, tx: Any = None, store: SanctionsStore | None = None,
                           outbox: Outbox | None = None) -> ScreenResult:
    """IF-17a company path: the stored result when it is newer than the latest list load,
    otherwise a live screen."""
    with open_context(tx, store=store, outbox=outbox) as ctx:
        cid = resolve_company_id(str(company_id), tx=ctx.tx)
        prev = ctx.store.get_screen(cid)
        if prev is not None and is_fresh(prev, ctx.store):
            return _result_of(prev, cached=True)
        return _screen_company(ctx, cid, force=True)


def record_decision(company_id: Any, decision: str, *, tx: Any = None, store: SanctionsStore | None = None) -> bool:
    """Stores an operator decision from ``sanctions.possible_match`` on the company's screen, so
    later screens honour it. The flag itself is written by M09 IF-09b ``sanctions_decision``."""
    if decision not in ("confirmed", "cleared"):
        raise KpError("VALIDATION", "decision must be confirmed or cleared")
    with open_context(tx, store=store) as ctx:
        cid = resolve_company_id(str(company_id), tx=ctx.tx)
        prev = ctx.store.get_screen(cid)
        if prev is None:
            return False
        return ctx.store.set_decision(cid, decision, prev.matched_entry_ids, utcnow())
