"""M09 evidence store: IF-09a (write / negate), IF-09c (reads) and canonical Company entities.

``tx`` everywhere is either a psycopg 3 connection whose transaction the caller owns, or an
``EvidenceRepo`` (tests pass a ``MemoryEvidenceRepo``). Reads accept ``tx=None`` and then open
their own short connection through the configured connection factory.
"""
from __future__ import annotations

import re
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Any, Callable, ContextManager, Iterable, Iterator, Mapping

from kp.m01_platform import KpError, get_logger, get_secret, new_id, span
from kp.m08_sources import SourceEntry, get_source

from .attributes import (
    InvalidAttribute,
    attribute_class,
    hs_heading_of,
    identity_key,
    is_allowed,
    validate_value,
)
from .models import (
    ANCHOR_KINDS,
    PDC_ORDER,
    Assertion,
    AssertionId,
    AssertionIn,
    Company,
    CompanyId,
    CompanyNotFound,
    ContactValue,
    MergeCycle,
    MissingPageReference,
    PersonalDataDisabled,
    utcnow,
)
from .norm import contact_value_hash, norm_hash, normalise, value_identifier_hashes
from .repo import EvidenceRepo, PgEvidenceRepo, cutoff_for

_log = get_logger("kp.m09_evidence.store")

# Event types (IF-02c). EV-01 is produced here; EV-03 by M17 (and IF-09b sanctions decisions);
# EV-04 by M10.
EV_ENTITY_CHANGED = "entity.changed"            # EV-01 {company_id, attribute_classes}
EV_SANCTIONS_FLAG_CHANGED = "sanctions.flag_changed"  # EV-03 {company_id, block}
EV_SUPPRESSION_ADDED = "suppression.added"      # EV-04 {hashes}

MAX_MERGE_HOPS = 10

# ---- counters --------------------------------------------------------------------------------

try:  # OpenTelemetry metrics are a no-op unless an SDK is configured.
    from opentelemetry import metrics as _otel_metrics

    _meter = _otel_metrics.get_meter("kp.m09_evidence")
    _suppressed_counter: Any = _meter.create_counter(
        "kp.m09.suppressed_skip", description="Assertion writes skipped because an identifier is suppressed")
except Exception:  # noqa: BLE001 — metrics must never break writes
    _suppressed_counter = None

_counts: dict[str, int] = {"suppressed_skip": 0, "written": 0, "refreshed": 0, "negated": 0}


def counters() -> dict[str, int]:
    """Process-local write counters (``suppressed_skip`` is the one the spec asks for)."""
    return dict(_counts)


def _count(name: str, attrs: Mapping[str, str] | None = None) -> None:
    _counts[name] = _counts.get(name, 0) + 1
    if name == "suppressed_skip" and _suppressed_counter is not None:
        try:
            _suppressed_counter.add(1, dict(attrs or {}))
        except Exception:  # noqa: BLE001
            pass


# ---- connections -----------------------------------------------------------------------------

ConnectionFactory = Callable[[], ContextManager[Any]]


def _default_connect() -> ContextManager[Any]:
    import psycopg

    # psycopg's connection context manager commits on a clean exit and rolls back on error.
    return psycopg.connect(get_secret("DATABASE_URL"))


_connect: ConnectionFactory = _default_connect


def set_connection_factory(fn: ConnectionFactory | None) -> None:
    """Replaces how reads and job handlers open a connection (``None`` restores the default)."""
    global _connect
    _connect = fn or _default_connect


def as_repo(tx: Any) -> EvidenceRepo:
    if isinstance(tx, EvidenceRepo):
        return tx
    if tx is None:
        raise KpError("INTERNAL", "a transaction is required for this operation")
    return PgEvidenceRepo(tx)


@contextmanager
def open_repo(tx: Any = None) -> Iterator[EvidenceRepo]:
    """Yields a repo over ``tx``, or over a fresh connection that commits on a clean exit."""
    if tx is not None:
        yield as_repo(tx)
        return
    with _connect() as conn:
        if isinstance(conn, EvidenceRepo):
            yield conn
        else:
            yield PgEvidenceRepo(conn)


# ---- companies -------------------------------------------------------------------------------

def normalise_anchor(kind: str, value: str) -> str:
    if kind not in ANCHOR_KINDS:
        raise KpError("VALIDATION", f'Unknown anchor kind "{kind}"')
    if not isinstance(value, str) or not value.strip():
        raise KpError("VALIDATION", f"{kind} anchor must be non-empty text")
    if kind == "domain":
        return normalise("domain", value)
    if kind == "registry":
        return normalise("registry", value)
    return re.sub(r"[^A-Za-z0-9]", "", value).upper()


def _anchor_class(kind: str) -> str:
    return "domain" if kind == "domain" else "registry"


def _resolve(repo: EvidenceRepo, company_id: str) -> Company:
    seen: list[str] = []
    cur = str(company_id)
    for _ in range(MAX_MERGE_HOPS + 1):
        c = repo.get_company(cur)
        if c is None:
            raise CompanyNotFound(cur)
        if c.merged_into is None:
            return c
        seen.append(cur)
        cur = c.merged_into
        if cur in seen:
            raise MergeCycle(str(company_id))
    raise MergeCycle(str(company_id))


def resolve_company_id(id: Any, *, tx: Any = None) -> CompanyId:
    """IF-09c. Follows ``merged_into`` up to 10 hops; raises MergeCycle on a cycle."""
    with open_repo(tx) as repo:
        return _resolve(repo, str(id)).id


def get_company(company_id: Any, *, tx: Any = None) -> Company | None:
    with open_repo(tx) as repo:
        return repo.get_company(str(company_id))


def create_company(
    tx: Any,
    *,
    display_name: str,
    country: str,
    city: str | None = None,
    primary_domain: str | None = None,
    anchors: Iterable[tuple[str, str]] = (),
) -> CompanyId:
    """Inserts a canonical company and its anchors (used by M18 resolve step 5).

    Raises AnchorConflict when an anchor already belongs to another company; the caller's
    transaction should then be rolled back and the lookup retried (M18).
    """
    repo = as_repo(tx)
    name = (display_name or "").strip()
    cc = (country or "").strip().upper()
    if not name or len(name) > 500:
        raise KpError("VALIDATION", "display_name must be 1..500 characters")
    if not re.match(r"^[A-Z]{2}$", cc):
        raise KpError("VALIDATION", "country must be an ISO 3166-1 alpha-2 code")
    now = utcnow()
    domain = normalise("domain", primary_domain) if primary_domain else None
    company = Company(id=new_id(), status="active", merged_into=None, display_name=name, country=cc,
                      city=(city or None), primary_domain=domain or None, created_at=now, updated_at=now)
    repo.insert_company(company)
    classes: set[str] = set()
    all_anchors = list(anchors)
    if domain and ("domain", domain) not in [(k, normalise_anchor(k, v)) for k, v in all_anchors]:
        all_anchors.append(("domain", domain))
    for kind, value in all_anchors:
        repo.insert_anchor(kind, normalise_anchor(kind, value), company.id)
        classes.add(_anchor_class(kind))
    if classes:
        repo.emit(EV_ENTITY_CHANGED, {"company_id": company.id, "attribute_classes": sorted(classes)})
    return company.id


def add_anchor(tx: Any, company_id: Any, kind: str, value: str) -> None:
    """Adds an anchor to an existing company (AnchorConflict if it belongs to another one)."""
    repo = as_repo(tx)
    c = _resolve(repo, str(company_id))
    norm = normalise_anchor(kind, value)
    if repo.get_anchor(kind, norm) == c.id:
        return
    repo.insert_anchor(kind, norm, c.id)
    repo.emit(EV_ENTITY_CHANGED, {"company_id": c.id, "attribute_classes": [_anchor_class(kind)]})


def update_company(tx: Any, company_id: Any, *, display_name: str | None = None, city: str | None = None,
                   primary_domain: str | None = None) -> None:
    """Updates descriptive fields of a canonical company and emits EV-01 when anything changed."""
    repo = as_repo(tx)
    c = _resolve(repo, str(company_id))
    fields: dict[str, Any] = {}
    classes: set[str] = set()
    if display_name is not None and display_name.strip() and display_name.strip() != c.display_name:
        fields["display_name"] = display_name.strip()
        classes.add("registry")
    if city is not None and city != c.city:
        fields["city"] = city or None
        classes.add("registry")
    if primary_domain is not None:
        d = normalise("domain", primary_domain) if primary_domain else None
        if d != c.primary_domain:
            fields["primary_domain"] = d
            classes.add("domain")
            if d:
                existing = repo.get_anchor("domain", d)
                if existing is None:
                    repo.insert_anchor("domain", d, c.id)
    if fields:
        repo.update_company(c.id, fields)
        repo.emit(EV_ENTITY_CHANGED, {"company_id": c.id, "attribute_classes": sorted(classes)})


def find_by_anchor(kind: str, value_norm: str, *, tx: Any = None) -> CompanyId | None:
    """IF-09c. Returns the *current* company for the anchor (merges followed), or None."""
    with open_repo(tx) as repo:
        cid = repo.get_anchor(kind, value_norm)
        if cid is None and kind in ANCHOR_KINDS:
            try:
                alt = normalise_anchor(kind, value_norm)
            except KpError:
                alt = value_norm
            if alt != value_norm:
                cid = repo.get_anchor(kind, alt)
        if cid is None:
            return None
        return _resolve(repo, cid).id


# ---- IF-09a ----------------------------------------------------------------------------------

def _has_page_reference(ref: Mapping[str, Any]) -> bool:
    url, captured = ref.get("url"), ref.get("captured_at")
    return isinstance(url, str) and bool(url.strip()) and captured is not None and str(captured).strip() != ""


def _effective_flags(src: SourceEntry, a: AssertionIn) -> tuple[bool, bool, str]:
    """Step 6: inherit from the source; the caller may only tighten."""
    can_display = src.can_display and (a.can_display if a.can_display is not None else True)
    can_export = src.can_export and (a.can_export if a.can_export is not None else True) and can_display
    pdc = src.personal_data_class
    if a.personal_data_class is not None and PDC_ORDER[a.personal_data_class] > PDC_ORDER[pdc]:
        pdc = a.personal_data_class
    return can_display, can_export, pdc


def _emit_changed(repo: EvidenceRepo, company_id: str, attributes: Iterable[str]) -> None:
    classes = sorted({attribute_class(a) for a in attributes})
    repo.emit(EV_ENTITY_CHANGED, {"company_id": company_id, "attribute_classes": classes})


def _write(a: AssertionIn, repo: EvidenceRepo, *, negation: bool) -> AssertionId | None:
    # 1. vocabulary
    if not is_allowed(a.attribute):
        raise InvalidAttribute(a.attribute)
    validate_value(a.attribute, a.value, partial=negation)
    # 2. licence register (SourceNotRegistered / SourceNotActive)
    src = get_source(a.source_id)
    # 3. DS-04: LLM-derived facts must point at the captured page
    if a.llm_assisted and not _has_page_reference(a.source_ref):
        raise MissingPageReference(a.attribute)
    # 4. named_person is modelled but disabled
    if a.personal_data_class == "named_person" or a.subject_type == "person":
        raise PersonalDataDisabled()
    company = _resolve(repo, str(a.subject_id))
    subject_id = company.id
    # 5. suppression (positive facts only: a negative fact can only reduce what is shown)
    if not negation:
        hashes = value_identifier_hashes(a.value) + [norm_hash("company_id", subject_id)]
        hit = repo.suppressed(hashes)
        if hit:
            _count("suppressed_skip", {"attribute": a.attribute, "source_id": a.source_id})
            _log.info("assertion skipped: suppressed identifier",
                      extra={"attribute": a.attribute, "source_id": a.source_id, "company_id": subject_id})
            return None
    # 6. licence flags
    can_display, can_export, pdc = _effective_flags(src, a)
    now = utcnow()
    observed_at = a.observed_at or now
    checked_at = a.checked_at or observed_at
    # 7. supersede
    key = identity_key(a.attribute, a.value)
    active = repo.active_assertions(subject_id, a.attribute, a.polarity)
    same = [e for e in active if key is None or identity_key(a.attribute, e.value) == key]
    for e in same:
        if e.value == a.value:
            repo.touch_checked_at(e.id, checked_at)
            _count("refreshed")
            _emit_changed(repo, subject_id, [a.attribute])  # 8.
            return e.id
    row = Assertion(
        id=new_id(), subject_type="company", subject_id=subject_id, attribute=a.attribute, value=dict(a.value),
        polarity=a.polarity, source_id=src.id, source_type=src.source_type, source_ref=dict(a.source_ref),
        observed_at=observed_at, checked_at=checked_at, confidence=float(a.confidence),
        can_display=can_display, can_export=can_export, personal_data_class=pdc,  # type: ignore[arg-type]
        region=a.region or company.country, producer=a.producer, producer_version=a.producer_version,
        llm_assisted=a.llm_assisted, superseded_by=None, hs_heading=hs_heading_of(a.attribute, a.value),
        created_at=now,
    )
    repo.insert_assertion(row)
    repo.mark_superseded([e.id for e in same], row.id)
    _count("negated" if negation else "written")
    # 8. EV-01 in the same transaction
    _emit_changed(repo, subject_id, [a.attribute])
    return row.id


def write_assertion(a: AssertionIn | Mapping[str, Any], *, tx: Any) -> AssertionId | None:
    """IF-09a. Validates, inherits licence flags, supersedes, and emits EV-01 in ``tx``.

    Returns the assertion id (new, or the existing one when only ``checked_at`` was refreshed),
    or ``None`` when an identifier in the value is suppressed.
    """
    inp = a if isinstance(a, AssertionIn) else AssertionIn.model_validate(dict(a))
    with span("m09.write_assertion", {"attribute": inp.attribute, "source_id": inp.source_id}):
        return _write(inp, as_repo(tx), negation=inp.polarity == "negative")


def negate(subject_id: Any, attribute: str, value_match: dict[str, Any], source_id: str,
           source_ref: dict[str, Any], *, tx: Any, confidence: float = 1.0, observed_at: datetime | None = None,
           producer: str = "m09", producer_version: str = "1", llm_assisted: bool = False) -> AssertionId:
    """IF-09a. Records a negative assertion ("this contact is invalid", "not a buyer of 7208").

    ``value_match`` identifies the positive fact(s) it contradicts: every key/value in it must
    appear in the positive value, and for keyed attributes it must carry the identity field.
    """
    inp = AssertionIn(
        subject_id=subject_id, attribute=attribute, value=dict(value_match), polarity="negative",
        source_id=source_id, source_ref=dict(source_ref), observed_at=observed_at, checked_at=observed_at,
        confidence=confidence, producer=producer, producer_version=producer_version, llm_assisted=llm_assisted,
    )
    with span("m09.negate", {"attribute": attribute, "source_id": source_id}):
        out = _write(inp, as_repo(tx), negation=True)
    if out is None:  # negations are never suppressed; this is defensive
        raise KpError("INTERNAL", "negative assertion was not written")
    return out


def put_contact_value(tx: Any, assertion_id: Any, kind: str, value: str) -> str:
    """Stores the raw contact value for a ``contact.<kind>`` assertion (read only by M29).

    The value's hash must equal the assertion's ``value.value_hash``. Returns the hash.
    """
    repo = as_repo(tx)
    a = repo.get_assertion(str(assertion_id))
    if a is None:
        raise KpError("NOT_FOUND", f"assertion {assertion_id} does not exist")
    if a.attribute != f"contact.{kind}":
        raise KpError("VALIDATION", f"assertion {assertion_id} is {a.attribute}, not contact.{kind}")
    if not isinstance(value, str) or not value.strip() or len(value) > 2048:
        raise KpError("VALIDATION", "contact value must be 1..2048 characters")
    h = contact_value_hash(kind, value)
    if a.value.get("value_hash") != h:
        raise KpError("VALIDATION", "contact value does not match the assertion's value_hash")
    repo.put_contact_value(ContactValue(assertion_id=a.id, company_id=a.subject_id, kind=kind,
                                        value=value.strip(), value_hash=h))
    return h


# ---- IF-09c reads ----------------------------------------------------------------------------

def get_assertions(subject_id: Any, attributes: list[str] | None = None, include_superseded: bool = False,
                   *, tx: Any = None) -> list[Assertion]:
    with open_repo(tx) as repo:
        sid = str(subject_id)
        c = repo.get_company(sid)
        if c is not None and c.merged_into is not None:
            sid = _resolve(repo, sid).id
        return repo.list_assertions(sid, list(attributes) if attributes is not None else None, include_superseded)


def stale(attribute_prefix: str, older_than: timedelta, limit: int, *, tx: Any = None) -> list[Assertion]:
    if not isinstance(attribute_prefix, str) or not attribute_prefix:
        raise KpError("VALIDATION", "attribute_prefix is required")
    if not isinstance(limit, int) or not 1 <= limit <= 100_000:
        raise KpError("VALIDATION", "limit must be an integer in 1..100000")
    with open_repo(tx) as repo:
        return repo.stale(attribute_prefix, cutoff_for(older_than), limit)


# ---- merge (used by IF-09b merge_confirm) ------------------------------------------------------

def _merge_key(a: Assertion) -> tuple[str, str, str | None]:
    return (a.attribute, a.polarity, identity_key(a.attribute, a.value))


def merge_companies(repo: EvidenceRepo, keep_id: str, merge_id: str) -> CompanyId:
    """Sets ``merge.merged_into = keep``, moves anchors, re-points assertions and contact values,
    supersedes now-duplicate active assertions (history kept) and emits EV-01 for ``keep``."""
    keep = _resolve(repo, keep_id)
    gone = _resolve(repo, merge_id)
    if keep.id == gone.id:
        return keep.id
    repo.update_company(gone.id, {"status": "merged", "merged_into": keep.id})
    repo.move_anchors(gone.id, keep.id)
    repo.repoint_assertions(gone.id, keep.id)
    repo.repoint_contact_values(gone.id, keep.id)
    groups: dict[tuple[str, str, str | None], list[Assertion]] = {}
    for a in repo.list_assertions(keep.id, None, False):
        groups.setdefault(_merge_key(a), []).append(a)
    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda x: (x.observed_at, x.checked_at, x.created_at))
        winner = group[-1]
        repo.mark_superseded([x.id for x in group[:-1]], winner.id)
    if not keep.primary_domain and gone.primary_domain:
        repo.update_company(keep.id, {"primary_domain": gone.primary_domain})
    repo.delete_search_docs(gone.id)
    repo.delete_profile_doc(gone.id)
    classes = {attribute_class(a.attribute) for a in repo.list_assertions(keep.id, None, False)}
    classes |= {_anchor_class(k) for k, _ in repo.anchors_of(keep.id)}
    repo.emit(EV_ENTITY_CHANGED, {"company_id": keep.id, "attribute_classes": sorted(classes)})
    return keep.id
