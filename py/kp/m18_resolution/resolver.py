"""M18 IF-18a ``resolve(candidate, *, tx) -> Resolution``.

Algorithm (LLD M18):
 1. Normalise the name (M17 ``normalise_name``) and the domain (M10 spec).
 2. Suppression: any suppressed domain or registry hash → ``method='suppressed'``, no company, no
    write. The caller drops the record (REQ-037: removed data is never resurrected).
 3. Anchors in the order lei → registry → vat → domain (free-mail / marketplace domains excluded).
    First match → ``anchor`` (confidence 1.0). Anchors pointing at different companies → file
    ``entity.merge_review`` and keep the lei/registry (first-ranked) match.
 4. Fuzzy: same country, trigram name similarity > 0.5;
    score = 0.6·name_sim + 0.2·city_match + 0.2·address_token_overlap.
    ≥ 0.92 → match (``fuzzy``); 0.80–0.92 → new company + ``entity.merge_review {a, b, score}``
    (``review``); < 0.80 → new company (``new``).
 5. New company: insert ``company`` and its anchors (M09). An anchor unique-violation race → the
    insert is rolled back to a savepoint and the lookup is retried once.

Everything runs in the caller's transaction ``tx`` (a psycopg connection, or an ``EvidenceRepo``;
tests pass a ``MemoryEvidenceRepo``). Merge reviews are handed to the serving plane (M11) through
the ``m18.file_merge_review`` job, enqueued in the same transaction.

Additions beyond the LLD text (recorded as deviation notes):
- A matched company whose own id is suppressed is also returned as ``suppressed``.
- Anchors the candidate carries that are still free are attached to the matched company.
- ``confidence`` for ``new`` / ``review`` is 1 − best fuzzy score (confidence that the record is a
  distinct company); 1.0 when there was no fuzzy candidate.
- A merge review for a pair that already has a merge decision (M09 ``merge_decision``) is not filed again.
"""
from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any, ContextManager, Mapping
from uuid import UUID

from kp.m01_platform import KpError, get_logger, span
from kp.m09_evidence import (
    AnchorConflict,
    EvidenceRepo,
    MemoryEvidenceRepo,
    add_anchor,
    create_company,
    find_by_anchor,
    get_company,
    normalise_anchor,
    open_repo,
)
from kp.m10_policy import norm_hash

from .models import (
    MATCH_THRESHOLD,
    REVIEW_THRESHOLD,
    W_ADDRESS,
    W_CITY,
    W_NAME,
    Candidate,
    MatchKey,
    MergeReview,
    Resolution,
    ScoredMatch,
)
from .normalise import (
    address_overlap,
    address_tokens,
    is_excluded_anchor_domain,
    normalise_city,
    normalise_domain,
    normalise_name,
    trigram_similarity,
)
from .store import MatchStore, Outbox, PgMatchStore, PgOutbox, memory_backends

_log = get_logger("kp.m18_resolution.resolver")

FILE_MERGE_REVIEW_JOB = "m18.file_merge_review"   # serving queue; handled by apps/web m18_resolution
MERGE_REVIEW_TYPE = "entity.merge_review"
ANCHOR_ORDER: tuple[str, ...] = ("lei", "registry", "vat", "domain")

_counts: dict[str, int] = {"anchor": 0, "fuzzy": 0, "new": 0, "suppressed": 0, "review": 0,
                           "anchor_conflict": 0, "race_retry": 0}


def counters() -> dict[str, int]:
    """Process-local outcome counters."""
    return dict(_counts)


# ---- preparation -----------------------------------------------------------------------------

@dataclass(frozen=True)
class Prepared:
    cand: Candidate
    name_norm: str
    domain_norm: str | None
    domain_is_anchor: bool
    city_norm: str | None
    address_tokens: frozenset[str]
    anchors: tuple[tuple[str, str], ...]          # (kind, value_norm) in ANCHOR_ORDER
    suppression_hashes: tuple[str, ...]


def _norm_anchor(kind: str, raw: str) -> str | None:
    try:
        v = normalise_anchor(kind, raw)
    except KpError:
        _log.info("anchor could not be normalised; ignored", extra={"kind": kind})
        return None
    return v or None


def prepare(c: Candidate) -> Prepared:
    """Step 1 (+ the anchor and suppression-hash lists used by steps 2 and 3)."""
    name_norm = normalise_name(c.name)
    if not name_norm:
        raise KpError("VALIDATION", "candidate name has no letters or digits", {"source_id": c.source_id})
    domain_norm = normalise_domain(c.domain)
    domain_is_anchor = bool(domain_norm) and not is_excluded_anchor_domain(domain_norm or "")

    anchors: list[tuple[str, str]] = []

    def _add(kind: str, raw: str | None) -> None:
        if not raw:
            return
        v = _norm_anchor(kind, raw)
        if v and (kind, v) not in anchors:
            anchors.append((kind, v))

    _add("lei", c.lei)
    for rid in c.registry_ids:
        _add("registry", rid)
    _add("vat", c.vat)
    if domain_is_anchor and domain_norm:
        _add("domain", domain_norm)

    hashes: list[str] = []
    if domain_norm:
        hashes.append(norm_hash("domain", domain_norm))
    for rid in c.registry_ids:
        try:
            hashes.append(norm_hash("registry", rid))
        except KpError:
            _log.info("registry id could not be hashed; ignored for suppression")
    return Prepared(cand=c, name_norm=name_norm, domain_norm=domain_norm, domain_is_anchor=domain_is_anchor,
                    city_norm=normalise_city(c.city), address_tokens=address_tokens(c.address),
                    anchors=tuple(anchors), suppression_hashes=tuple(dict.fromkeys(h for h in hashes if h)))


def score(p: Prepared, key: MatchKey) -> ScoredMatch:
    """Step 4 score = 0.6 × name sim + 0.2 × city match + 0.2 × address token overlap."""
    name_sim = trigram_similarity(p.name_norm, key.name_norm)
    city = 1.0 if p.city_norm and key.city_norm and p.city_norm == key.city_norm else 0.0
    addr = address_overlap(p.address_tokens, key.address_tokens)
    total = W_NAME * name_sim + W_CITY * city + W_ADDRESS * addr
    return ScoredMatch(key=key, score=round(total, 6), name_sim=name_sim, city_match=city, address_overlap=addr)


# ---- context ---------------------------------------------------------------------------------

@dataclass
class _Ctx:
    repo: EvidenceRepo
    store: MatchStore
    outbox: Outbox
    conn: Any


def _backends(repo: EvidenceRepo, tx: Any, store: MatchStore | None, outbox: Outbox | None) -> _Ctx:
    conn = getattr(repo, "conn", None)
    if conn is None and not isinstance(tx, EvidenceRepo):
        conn = tx
    if isinstance(repo, MemoryEvidenceRepo):
        ms, mo = memory_backends(repo)
        return _Ctx(repo=repo, store=store or ms, outbox=outbox or mo, conn=None)
    if conn is None and (store is None or outbox is None):
        raise KpError("INTERNAL", "resolve(): a psycopg connection, or explicit store and outbox, is required")
    return _Ctx(repo=repo, store=store or PgMatchStore(conn), outbox=outbox or PgOutbox(conn), conn=conn)


def _savepoint(ctx: _Ctx) -> ContextManager[Any]:
    """A savepoint in the caller's transaction (psycopg ``conn.transaction()`` nests as a savepoint)."""
    tx_fn = getattr(ctx.conn, "transaction", None) if ctx.conn is not None else None
    return tx_fn() if callable(tx_fn) else nullcontext()


def _suppressed(ctx: _Ctx, hashes: list[str] | tuple[str, ...]) -> bool:
    return bool(ctx.repo.suppressed(list(hashes)))


def _company_suppressed(ctx: _Ctx, company_id: str) -> bool:
    return _suppressed(ctx, [norm_hash("company_id", company_id)])


# ---- review filing ---------------------------------------------------------------------------

def _file_review(ctx: _Ctx, review: MergeReview) -> bool:
    if review.a == review.b:
        return False
    decided = ctx.store.merge_decision(review.a, review.b)
    if decided is not None:
        _log.info("merge review skipped: pair already decided",
                  extra={"a": review.a, "b": review.b, "decision": decided})
        return False
    lo, hi = sorted((review.a, review.b))
    ctx.outbox.enqueue(FILE_MERGE_REVIEW_JOB, "serving", review.to_payload(), f"m18:merge:{lo}:{hi}")
    _log.info("merge review filed", extra={"a": review.a, "b": review.b, "score": review.score,
                                           "reason": review.reason})
    return True


# ---- write helpers ---------------------------------------------------------------------------

def _attach_free_anchors(ctx: _Ctx, company_id: str, p: Prepared, skip: set[tuple[str, str]]) -> None:
    """Adds the candidate's anchors that no company holds yet to ``company_id``."""
    for kind, value in p.anchors:
        if (kind, value) in skip:
            continue
        try:
            add_anchor(ctx.repo, company_id, kind, value)
        except AnchorConflict as e:
            _log.info("anchor already held by another company; not moved",
                      extra={"kind": kind, "company_id": company_id, "holder": e.existing})


def _ensure_key(ctx: _Ctx, company_id: str, p: Prepared) -> None:
    existing = ctx.store.get_key(company_id)
    if existing is not None:
        if (existing.city_norm is None and p.city_norm) or (not existing.address_tokens and p.address_tokens):
            ctx.store.upsert_key(MatchKey(company_id=company_id, country=existing.country,
                                          name_norm=existing.name_norm, city_norm=p.city_norm,
                                          address_tokens=p.address_tokens))
        return
    company = get_company(company_id, tx=ctx.repo)
    if company is None:
        return
    name_norm = normalise_name(company.display_name) or p.name_norm
    ctx.store.upsert_key(MatchKey(company_id=company_id, country=company.country, name_norm=name_norm,
                                  city_norm=normalise_city(company.city) or p.city_norm,
                                  address_tokens=p.address_tokens))


def _create(ctx: _Ctx, p: Prepared) -> str:
    """Step 5 inside a savepoint; AnchorConflict propagates after the savepoint is rolled back."""
    c = p.cand
    with _savepoint(ctx):
        cid = create_company(
            ctx.repo, display_name=c.name, country=c.country, city=c.city,
            primary_domain=p.domain_norm if p.domain_is_anchor else None,
            anchors=list(p.anchors),
        )
        ctx.store.upsert_key(MatchKey(company_id=cid, country=c.country, name_norm=p.name_norm,
                                      city_norm=p.city_norm, address_tokens=p.address_tokens,
                                      display_name=c.name))
    return cid


# ---- steps -----------------------------------------------------------------------------------

def _anchor_step(ctx: _Ctx, p: Prepared) -> Resolution | None:
    hits: list[tuple[str, str, str]] = []
    for kind, value in p.anchors:
        cid = find_by_anchor(kind, value, tx=ctx.repo)
        if cid is not None:
            hits.append((kind, value, str(cid)))
    if not hits:
        return None
    chosen = hits[0][2]
    if _company_suppressed(ctx, chosen):
        _counts["suppressed"] += 1
        return Resolution(company_id=None, created=False, confidence=1.0, method="suppressed")
    others: dict[str, list[str]] = {}
    for kind, _, cid in hits[1:]:
        if cid != chosen:
            others.setdefault(cid, []).append(kind)
    if others:
        _counts["anchor_conflict"] += 1
        a = get_company(chosen, tx=ctx.repo)
        for other, kinds in others.items():
            b = get_company(other, tx=ctx.repo)
            chosen_kinds = [k for k, _, cid in hits if cid == chosen]
            _file_review(ctx, MergeReview(
                a=chosen, b=other, score=1.0, reason="anchor_conflict", country=p.cand.country,
                a_name=a.display_name if a else p.cand.name, b_name=b.display_name if b else p.cand.name,
                source_id=p.cand.source_id,
                conflicting_anchors=tuple(dict.fromkeys(chosen_kinds + kinds)),
            ))
    _attach_free_anchors(ctx, chosen, p, skip={(k, v) for k, v, _ in hits})
    _ensure_key(ctx, chosen, p)
    _counts["anchor"] += 1
    return Resolution(company_id=UUID(chosen), created=False, confidence=1.0, method="anchor")


def _best(p: Prepared, keys: list[MatchKey]) -> ScoredMatch | None:
    scored = [score(p, k) for k in keys]
    if not scored:
        return None
    scored.sort(key=lambda s: (-s.score, -s.name_sim, s.key.company_id))
    return scored[0]


def _fuzzy_and_create(ctx: _Ctx, p: Prepared, *, allow_retry: bool) -> Resolution:
    best = _best(p, ctx.store.candidates(p.cand.country, p.name_norm))
    if best is not None and best.score >= MATCH_THRESHOLD:
        cid = best.key.company_id
        if _company_suppressed(ctx, cid):
            _counts["suppressed"] += 1
            return Resolution(company_id=None, created=False, confidence=1.0, method="suppressed")
        _attach_free_anchors(ctx, cid, p, skip=set())
        _ensure_key(ctx, cid, p)
        _counts["fuzzy"] += 1
        return Resolution(company_id=UUID(cid), created=False, confidence=min(best.score, 1.0), method="fuzzy")

    try:
        new_id = _create(ctx, p)
    except AnchorConflict:
        if not allow_retry:
            raise
        # Step 5: another writer took one of the anchors between our lookup and insert.
        _counts["race_retry"] += 1
        _log.info("anchor race on company insert; retrying the lookup once",
                  extra={"source_id": p.cand.source_id})
        return _run(ctx, p, allow_retry=False)

    distinct_conf = round(1.0 - best.score, 6) if best is not None else 1.0
    if best is not None and best.score >= REVIEW_THRESHOLD:
        _file_review(ctx, MergeReview(
            a=best.key.company_id, b=new_id, score=best.score, reason="fuzzy", country=p.cand.country,
            a_name=best.key.display_name or best.key.name_norm, b_name=p.cand.name, source_id=p.cand.source_id,
            name_sim=best.name_sim, city_match=best.city_match, address_overlap=best.address_overlap,
        ))
        _counts["review"] += 1
        return Resolution(company_id=UUID(new_id), created=True, confidence=max(0.0, distinct_conf), method="review")
    _counts["new"] += 1
    return Resolution(company_id=UUID(new_id), created=True, confidence=max(0.0, distinct_conf), method="new")


def _run(ctx: _Ctx, p: Prepared, *, allow_retry: bool) -> Resolution:
    anchored = _anchor_step(ctx, p)
    if anchored is not None:
        return anchored
    return _fuzzy_and_create(ctx, p, allow_retry=allow_retry)


# ---- API -------------------------------------------------------------------------------------

def resolve(c: Candidate | Mapping[str, Any], *, tx: Any, store: MatchStore | None = None,
            outbox: Outbox | None = None) -> Resolution:
    """IF-18a. Resolves a source record to one canonical company inside ``tx``.

    ``method='suppressed'`` → ``company_id is None`` and nothing was written; drop the record.
    """
    if tx is None:
        raise KpError("INTERNAL", "resolve() requires the caller's transaction")
    cand = c if isinstance(c, Candidate) else Candidate.model_validate(dict(c))
    with span("m18.resolve", {"source_id": cand.source_id, "country": cand.country}):
        p = prepare(cand)
        with open_repo(tx) as repo:
            ctx = _backends(repo, tx, store, outbox)
            # Step 2 — before any lookup that could lead to a write.
            if _suppressed(ctx, p.suppression_hashes):
                _counts["suppressed"] += 1
                _log.info("candidate dropped: suppressed identifier", extra={"source_id": cand.source_id})
                return Resolution(company_id=None, created=False, confidence=1.0, method="suppressed")
            return _run(ctx, p, allow_retry=True)
