"""M19 IF-19a ``classify(company_id, evidence_texts, *, tx) -> Classification``.

Logic (LLD M19):
 1. Curated list ``/config/logistics_entities.yaml`` (domains and normalised names) → logistics, 1.0.
 2. Keyword rules on the name (freight, logistics, forwarding, shipping agency, customs broker,
    NVOCC …) → logistics, 0.85.
 3. Otherwise the LLM (tier ``classify``, pii_free) over the evidence snippets only; its output must
    cite evidence assertion ids, and an uncited result is ``unknown``.
 4. Writes ``logistics_flag`` and ``buyer_type`` assertions with ``source_id='operator.classifier'``
    (source type ``operator``) and a ``source_ref`` listing the evidence assertion ids. Logistics
    entities are hidden from buyer results by M10 through the projection's ``is_logistics``; nothing
    is deleted (REQ-020). ``buyer_type`` feeds the type filter (REQ-016, REQ-018).

Write rules (additions recorded as deviation notes):
- A rule hit (steps 1–2) skips the LLM; ``buyer_type`` is then ``unknown`` (a logistics
  intermediary is not a buyer) and no ``buyer_type`` assertion is written.
- ``buyer_type='unknown'`` is never written: it would supersede a real type from another source.
- ``logistics_flag {is_logistics: false}`` is written only to withdraw an earlier positive flag of
  the classifier's own; otherwise a negative result writes nothing.
- An active ``logistics_flag`` / ``buyer_type`` from an operator source other than the classifier
  (``operator.manual``) is never overwritten; a ``buyer_type`` from any other source is replaced
  only by a classification with at least the same confidence.
- LLM-derived writes are ``llm_assisted`` and, per the M09 DS-04 rule, carry ``url`` and
  ``captured_at`` of a cited evidence page. If no cited evidence has a page reference the LLM
  result is returned but not written.
"""
from __future__ import annotations

from typing import Any, Mapping, Sequence
from uuid import UUID

from kp.m01_platform import KpError, get_logger, span
from kp.m09_evidence import Assertion, CompanyNotFound, get_assertions, open_repo, resolve_company_id, write_assertion

from .llm import LlmFn, LlmVerdict, llm_classify
from .models import (
    CLASSIFIER_SOURCE_ID,
    PRODUCER,
    PRODUCER_VERSION,
    Classification,
    EvidenceText,
)
from .rules import CuratedList, RuleHit, rule_hit

_log = get_logger("kp.m19_classifiers.classifier")

_counts: dict[str, int] = {"curated": 0, "keyword": 0, "llm": 0, "llm_uncited": 0, "no_evidence": 0,
                           "written": 0, "skipped_protected": 0, "skipped_no_page_ref": 0}


def counters() -> dict[str, int]:
    """Process-local outcome counters."""
    return dict(_counts)


def _as_evidence(items: Sequence[EvidenceText | Mapping[str, Any]]) -> list[EvidenceText]:
    out: list[EvidenceText] = []
    for it in items or []:
        out.append(it if isinstance(it, EvidenceText) else EvidenceText.model_validate(dict(it)))
    return out


def _active(company_id: str, attribute: str, tx: Any) -> list[Assertion]:
    return [a for a in get_assertions(company_id, [attribute], tx=tx)
            if a.is_active and a.polarity == "positive"]


def _protected_by_operator(existing: list[Assertion]) -> Assertion | None:
    for a in existing:
        if a.source_id != CLASSIFIER_SOURCE_ID and a.source_type == "operator":
            return a
    return None


def _page_ref(cited: Sequence[UUID], evidence: Sequence[EvidenceText]) -> dict[str, Any] | None:
    by_id = {e.assertion_id: e for e in evidence}
    for aid in cited:
        e = by_id.get(aid)
        if e is not None and e.has_page_reference:
            return {"url": e.url, "captured_at": e.captured_at_iso()}
    return None


def _source_ref(evidence_ids: Sequence[UUID], method: str, rule: str | None,
                page: Mapping[str, Any] | None, model: str | None) -> dict[str, Any]:
    ref: dict[str, Any] = {"evidence_assertion_ids": [str(i) for i in evidence_ids], "method": method}
    if rule:
        ref["rule"] = rule
    if model:
        ref["model"] = model
    if page:
        ref.update(page)
    return ref


def _write(tx: Any, company_id: str, attribute: str, value: dict[str, Any], confidence: float,
           source_ref: dict[str, Any], llm_assisted: bool) -> str | None:
    aid = write_assertion({
        "subject_id": company_id, "attribute": attribute, "value": value, "source_id": CLASSIFIER_SOURCE_ID,
        "source_ref": source_ref, "confidence": round(confidence, 4), "producer": PRODUCER,
        "producer_version": PRODUCER_VERSION, "llm_assisted": llm_assisted,
    }, tx=tx)
    if aid is not None:
        _counts["written"] += 1
    return aid


def _write_logistics(tx: Any, company_id: str, c: Classification, evidence: Sequence[EvidenceText],
                     model: str | None) -> str | None:
    existing = _active(company_id, "logistics_flag", tx)
    guard = _protected_by_operator(existing)
    if guard is not None:
        _counts["skipped_protected"] += 1
        _log.info("logistics_flag not written: operator decision stands",
                  extra={"company_id": company_id, "assertion_id": guard.id})
        return None
    ours_positive = any(a.source_id == CLASSIFIER_SOURCE_ID and a.value.get("is_logistics", True) is True
                        for a in existing)
    if not c.is_logistics and not ours_positive:
        return None
    llm_assisted = c.logistics_method == "llm"
    page = None
    if llm_assisted:
        page = _page_ref(c.evidence_assertion_ids, evidence)
        if page is None:
            _counts["skipped_no_page_ref"] += 1
            _log.info("llm logistics result not written: no cited evidence has a page reference",
                      extra={"company_id": company_id})
            return None
    value: dict[str, Any] = {"is_logistics": c.is_logistics, "method": c.logistics_method}
    if c.matched_rule:
        value["rule"] = c.matched_rule
    # The confidence is in the stated answer (logistics or not), as the LLM prompt asks for.
    confidence = c.logistics_confidence
    ids = c.evidence_assertion_ids if llm_assisted else []
    return _write(tx, company_id, "logistics_flag", value, confidence,
                  _source_ref(ids, c.logistics_method, c.matched_rule, page, model), llm_assisted)


def _write_buyer_type(tx: Any, company_id: str, c: Classification, evidence: Sequence[EvidenceText],
                      model: str | None) -> str | None:
    if c.buyer_type == "unknown" or c.is_logistics:
        return None
    existing = _active(company_id, "buyer_type", tx)
    guard = _protected_by_operator(existing)
    if guard is not None:
        _counts["skipped_protected"] += 1
        _log.info("buyer_type not written: operator decision stands",
                  extra={"company_id": company_id, "assertion_id": guard.id})
        return None
    for a in existing:
        if a.source_id != CLASSIFIER_SOURCE_ID and a.confidence > c.type_confidence:
            _counts["skipped_protected"] += 1
            _log.info("buyer_type not written: a more confident type from another source stands",
                      extra={"company_id": company_id, "assertion_id": a.id, "source_id": a.source_id})
            return None
    page = _page_ref(c.evidence_assertion_ids, evidence)
    if page is None:
        _counts["skipped_no_page_ref"] += 1
        _log.info("llm buyer_type not written: no cited evidence has a page reference",
                  extra={"company_id": company_id})
        return None
    return _write(tx, company_id, "buyer_type", {"type": c.buyer_type, "method": "llm"}, c.type_confidence,
                  _source_ref(c.evidence_assertion_ids, "llm", None, page, model), True)


def _from_rule(hit: RuleHit) -> Classification:
    return Classification(is_logistics=True, logistics_confidence=hit.confidence, buyer_type="unknown",
                          type_confidence=0.0, evidence_assertion_ids=[], logistics_method=hit.method,  # type: ignore[arg-type]
                          matched_rule=hit.rule)


def _from_llm(v: LlmVerdict) -> Classification:
    return Classification(is_logistics=v.is_logistics, logistics_confidence=v.logistics_confidence,
                          buyer_type=v.buyer_type, type_confidence=v.type_confidence,  # type: ignore[arg-type]
                          evidence_assertion_ids=list(v.cited), logistics_method="llm" if v.cited else "none")


def classify(company_id: UUID | str, evidence_texts: Sequence[EvidenceText | Mapping[str, Any]], *, tx: Any,
             llm: LlmFn | None = None, curated: CuratedList | None = None, write: bool = True,
             correlation_id: str | None = None, job_type: str | None = None) -> Classification:
    """IF-19a. Classifies the company and (unless ``write=False``) records the result in M09 in ``tx``.

    ``company_id`` may be a merged-away id; the current company is used. Raises ``CompanyNotFound``
    for an unknown company, and the M03 errors (UPSTREAM_UNAVAILABLE, LLM_BAD_OUTPUT) when the LLM
    step fails, in which case nothing is written and the caller's job should retry.
    """
    if tx is None:
        raise KpError("INTERNAL", "classify() requires the caller's transaction")
    evidence = _as_evidence(evidence_texts)
    with span("m19.classify", {"company_id": str(company_id), "evidence": len(evidence)}):
        with open_repo(tx) as repo:
            cid = resolve_company_id(str(company_id), tx=repo)
            company = repo.get_company(str(cid)) if cid is not None else None
            if company is None:
                raise CompanyNotFound(str(company_id))
            domains = [company.primary_domain]
            hit = rule_hit(company.display_name, domains, curated)
            model: str | None = None
            if hit is not None:
                _counts[hit.method] += 1
                result = _from_rule(hit)
            elif not evidence:
                _counts["no_evidence"] += 1
                result = Classification(is_logistics=False, logistics_confidence=0.0, buyer_type="unknown",
                                        type_confidence=0.0)
            else:
                verdict = llm_classify(company.display_name, company.country, evidence, llm=llm,
                                       correlation_id=correlation_id, job_type=job_type)
                model = verdict.model
                _counts["llm" if verdict.cited else "llm_uncited"] += 1
                result = _from_llm(verdict)
            if write:
                written: list[str] = []
                for fn in (_write_logistics, _write_buyer_type):
                    aid = fn(repo, company.id, result, evidence, model)
                    if aid is not None:
                        written.append(str(aid))
                result = result.model_copy(update={"written_assertion_ids": written})
            _log.info("m19 classified company", extra={"company_id": company.id, **result.summary()})
            return result
