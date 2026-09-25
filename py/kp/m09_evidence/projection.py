"""M09 projection builder (DS-05 read models: ``search_doc`` and ``profile_doc``).

``build_projection`` is a pure function from a company, its active assertions and anchors to
the rows to store. ``project_company`` loads, builds and writes them through an EvidenceRepo.

Invariants (LLD M09):
- contact slots hold ``{assertion_id, kind, source_type, checked_at, deliverability}`` and
  **never** a contact value; values live only in ``contact_value``;
- facts with ``can_display=false`` are left out; their ids go into ``hidden_assertion_ids``;
- ``origin_india`` / ``origin_competitor`` are ``unknown`` unless an activity aggregate exists;
- a closed company keeps only its profile doc (``status: closed``);
- a suppressed company identifier (company id, domain, registry id) removes all its docs, and a
  fact carrying a suppressed identifier is dropped.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Callable, Iterable

from kp.m01_platform import get_logger, span

from .attributes import CONTACT_ATTRIBUTES, TRUST_CHECK_PREFIX, contact_kind, identity_key
from .models import Assertion, Company, MergeCycle, utcnow
from .norm import dedupe, norm_hash, value_identifier_hashes
from .repo import EvidenceRepo
from .store import _resolve

_log = get_logger("kp.m09_evidence.projection")

PROJECTION_VERSION = 1
# Origins that count as "competitor" supply for an Indian exporter [tunable] (see deviations).
COMPETITOR_ORIGINS: frozenset[str] = frozenset({"CN", "VN", "BD", "PK", "LK", "TH", "ID", "TR"})
# Ranking used for "strongest source type" in search results.
SOURCE_STRENGTH: dict[str, int] = {
    "customs": 7, "registry": 6, "operator": 5, "website": 4, "directory": 3, "market_stats": 2,
    "user_report": 1, "sanctions": 0, "nomenclature": 0,
}
EVIDENCE_SUMMARY_MAX = 3
VOLUME_SCORE_LOG_SPAN = 7.0  # log10(kg) at which volume_score saturates at 1.0 [tunable]


@dataclass
class ProjectionResult:
    company_id: str
    purge: bool = False                       # delete every doc for the company
    search_rows: list[dict[str, Any]] = field(default_factory=list)
    profile_row: dict[str, Any] | None = None
    closed: bool = False


def _iso(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


def _date_of(v: Any) -> date | None:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, str) and len(v) >= 10:
        try:
            return date.fromisoformat(v[:10])
        except ValueError:
            return None
    return None


def _negates(n: Assertion, p: Assertion) -> bool:
    if n.attribute != p.attribute:
        return False
    nk = identity_key(n.attribute, n.value)
    if nk is not None and nk != identity_key(p.attribute, p.value):
        return False
    if any(p.value.get(k) != v for k, v in n.value.items()):
        return False
    return n.observed_at >= p.observed_at


def _latest(items: Iterable[Assertion]) -> Assertion | None:
    best: Assertion | None = None
    for a in items:
        if best is None or (a.observed_at, a.checked_at, a.created_at) > (best.observed_at, best.checked_at,
                                                                           best.created_at):
            best = a
    return best


def _fact(a: Assertion) -> dict[str, Any]:
    return {
        "assertion_id": a.id, "attribute": a.attribute, "source_id": a.source_id, "source_type": a.source_type,
        "observed_at": _iso(a.observed_at), "checked_at": _iso(a.checked_at), "confidence": a.confidence,
        "llm_assisted": a.llm_assisted, "can_export": a.can_export, "personal_data_class": a.personal_data_class,
        "region": a.region,
    }


def company_identifier_hashes(company: Company, anchors: Iterable[tuple[str, str]]) -> list[str]:
    hs = [norm_hash("company_id", company.id)]
    if company.primary_domain:
        hs.append(norm_hash("domain", company.primary_domain))
    for kind, value in anchors:
        if kind == "domain":
            hs.append(norm_hash("domain", value))
        elif kind == "registry":
            hs.append(norm_hash("registry", value))
    return dedupe(hs)


def build_projection(
    company: Company,
    assertions: Iterable[Assertion],
    anchors: Iterable[tuple[str, str]],
    suppressed: Callable[[list[str]], set[str]],
    *,
    now: datetime | None = None,
) -> ProjectionResult:
    built_at = now or utcnow()
    anchors = list(anchors)
    res = ProjectionResult(company_id=company.id)
    company_hashes = company_identifier_hashes(company, anchors)

    active = [a for a in assertions if a.superseded_by is None and a.subject_id == company.id]
    negatives = [a for a in active if a.polarity == "negative"]
    positives = [a for a in active if a.polarity == "positive" and not any(_negates(n, a) for n in negatives)]

    per_fact_hashes = {a.id: value_identifier_hashes(a.value) for a in positives}
    all_hashes = dedupe([*company_hashes, *(h for hs in per_fact_hashes.values() for h in hs)])
    hit = suppressed(all_hashes) if all_hashes else set()
    if hit & set(company_hashes):
        res.purge = True
        return res
    if hit:
        positives = [a for a in positives if not (set(per_fact_hashes[a.id]) & hit)]

    hidden_ids = sorted(a.id for a in positives if not a.can_display)
    visible = [a for a in positives if a.can_display]
    by_attr: dict[str, list[Assertion]] = {}
    for a in visible:
        by_attr.setdefault(a.attribute, []).append(a)

    def all_of(attr: str, pool: Iterable[Assertion]) -> list[Assertion]:
        return [a for a in pool if a.attribute == attr]

    field_sources: dict[str, list[str]] = {}

    def src(field_name: str, *ids: str) -> None:
        field_sources.setdefault(field_name, [])
        field_sources[field_name].extend(i for i in ids if i not in field_sources[field_name])

    # Safety and filtering flags use every surviving positive fact, displayable or not.
    sanc = _latest(all_of("sanctions_flag", positives))
    sanctions_block = bool(sanc and sanc.value.get("block") is True)
    if sanc:
        src("sanctions_block", sanc.id)
    logi = _latest(all_of("logistics_flag", positives))
    is_logistics = bool(logi and logi.value.get("is_logistics", True) is True)
    if logi:
        src("is_logistics", logi.id)
    closed_a = _latest(all_of("status.closed", positives))
    closed = company.status == "closed" or bool(closed_a and closed_a.value.get("closed", True) is not False)
    not_buyer = {a.value["hs_heading"] for a in all_of("not_buyer_for", positives) if a.value.get("hs_heading")}

    # Buyer type
    bt = _latest(by_attr.get("buyer_type", []))
    buyer_type = None
    if bt:
        buyer_type = {"type": bt.value.get("type"), "confidence": bt.confidence, "source_type": bt.source_type,
                      "assertion_id": bt.id, "checked_at": _iso(bt.checked_at)}
        src("buyer_type", bt.id)

    # Trust
    rollup = _latest(by_attr.get("trust.rollup", []))
    trust_level = str(rollup.value.get("level")) if rollup else "unknown"
    checks = []
    for a in sorted((a for a in visible if a.attribute.startswith(TRUST_CHECK_PREFIX)), key=lambda x: x.attribute):
        checks.append({"id": a.attribute[len(TRUST_CHECK_PREFIX):], "outcome": a.value.get("outcome"),
                       "explanation_key": a.value.get("explanation_key"), "assertion_id": a.id,
                       "source_type": a.source_type, "checked_at": _iso(a.checked_at)})
        src("trust.checks", a.id)
    if rollup:
        src("trust.level", rollup.id)

    # Contacts — slots only, never values.
    slots: list[dict[str, Any]] = []
    contact_hashes: list[str] = []
    for a in positives:
        if a.attribute in CONTACT_ATTRIBUTES and isinstance(a.value.get("value_hash"), str):
            contact_hashes.append(a.value["value_hash"])
    for a in sorted((a for a in visible if a.attribute in CONTACT_ATTRIBUTES), key=lambda x: (x.attribute, x.id)):
        kind = contact_kind(a.attribute)
        slots.append({"assertion_id": a.id, "kind": kind, "source_type": a.source_type,
                      "checked_at": _iso(a.checked_at),
                      "deliverability": a.value.get("deliverability") or "unknown"})
        src(f"contacts.{kind}", a.id)
    contact_types = sorted({s["kind"] for s in slots if s["deliverability"] != "invalid"})

    # Evidence and activity per heading
    evidence: dict[str, list[Assertion]] = {}
    for a in by_attr.get("product_evidence", []):
        evidence.setdefault(a.value["hs_heading"], []).append(a)
    activity: dict[str, Assertion] = {}
    for a in by_attr.get("activity_aggregate", []):
        h = a.value["hs_heading"]
        if h not in activity or _latest([activity[h], a]) is a:
            activity[h] = a

    def origin_flags(h: str) -> tuple[str, str]:
        act = activity.get(h)
        if act is None:
            return "unknown", "unknown"
        origins = act.value.get("origins") or {}
        india = "yes" if (origins.get("IN") or 0) > 0 else "no"
        comp = "yes" if any((origins.get(cc) or 0) > 0 for cc in COMPETITOR_ORIGINS) else "no"
        return india, comp

    signals: dict[str, Any] = {}
    for attr in ("registry.match", "domain.age_days", "domain.mx", "domain.freemail"):
        s = _latest(by_attr.get(attr, []))
        if s:
            signals[attr] = {**s.value, "assertion_id": s.id, "source_type": s.source_type,
                             "checked_at": _iso(s.checked_at)}
            src(f"signals.{attr}", s.id)

    identifier_hashes = dedupe([*company_hashes, *contact_hashes])
    non_exportable = sorted(a.id for a in visible if not a.can_export)
    facts = [_fact(a) for a in sorted(visible, key=lambda x: (x.attribute, x.id))]

    evidence_out = []
    for h in sorted(evidence):
        for a in sorted(evidence[h], key=lambda x: x.observed_at, reverse=True):
            evidence_out.append({"assertion_id": a.id, "hs_heading": h, "snippet": a.value.get("snippet"),
                                 "url": a.value.get("url"), "source_type": a.source_type,
                                 "observed_at": _iso(a.observed_at), "checked_at": _iso(a.checked_at),
                                 "confidence": a.confidence, "llm_assisted": a.llm_assisted})
            src(f"evidence.{h}", a.id)
    activity_out = []
    for h in sorted(activity):
        a = activity[h]
        activity_out.append({"assertion_id": a.id, "hs_heading": h, "shipments_12m": a.value.get("shipments_12m"),
                             "volume_kg_12m": a.value.get("volume_kg_12m"), "last_seen": a.value.get("last_seen"),
                             "origins": a.value.get("origins") or {}, "source_type": a.source_type,
                             "checked_at": _iso(a.checked_at)})
        src(f"activity.{h}", a.id)
    headings = sorted((set(evidence) | set(activity)) - not_buyer)
    sourcing = {h: dict(zip(("origin_india", "origin_competitor"), origin_flags(h))) for h in sorted(activity)}

    profile_doc = {
        "company_id": company.id,
        "status": "closed" if closed else "active",
        "name": company.display_name,
        "country": company.country,
        "city": company.city,
        "website": company.primary_domain,
        "buyer_type": buyer_type,
        "hs_headings": headings,
        "evidence": evidence_out,
        "activity": activity_out,
        "sourcing": sourcing,
        "trust": {"level": trust_level, "rollup_assertion_id": rollup.id if rollup else None, "checks": checks},
        "contacts": slots,
        "contact_types": contact_types,
        "signals": signals,
        "is_logistics": is_logistics,
        "sanctions_block": sanctions_block,
        "not_buyer_for": sorted(not_buyer),
        "facts": facts,
        "field_sources": field_sources,
        "hidden_assertion_ids": hidden_ids,
        "non_exportable_assertion_ids": non_exportable,
        "projection_version": PROJECTION_VERSION,
        "built_at": _iso(built_at),
    }
    res.closed = closed
    res.profile_row = {
        "company_id": company.id, "doc": profile_doc, "identifier_hashes": identifier_hashes,
        "sanctions_block": sanctions_block, "is_logistics": is_logistics,
        "projection_version": PROJECTION_VERSION, "built_at": built_at,
    }
    if closed:
        return res

    for h in headings:
        ev = sorted(evidence.get(h, []), key=lambda x: x.observed_at, reverse=True)
        act = activity.get(h)
        heading_facts = [*ev, *([act] if act else [])]
        strongest = max((a.source_type for a in heading_facts), key=lambda t: SOURCE_STRENGTH.get(t, 0))
        india, comp = origin_flags(h)
        last_activity = _date_of(act.value.get("last_seen")) if act else None
        shipments = act.value.get("shipments_12m") if act else None
        kg = act.value.get("volume_kg_12m") if act else None
        volume_score = None
        if isinstance(kg, (int, float)) and kg > 0:
            volume_score = round(min(1.0, math.log10(1.0 + float(kg)) / VOLUME_SCORE_LOG_SPAN), 4)
        heading_ids = [a.id for a in heading_facts]
        doc_sources = {k: v for k, v in field_sources.items()
                       if not k.startswith(("evidence.", "activity.")) or k in (f"evidence.{h}", f"activity.{h}")}
        doc = {
            "company_id": company.id,
            "hs_heading": h,
            "name": company.display_name,
            "city": company.city,
            "country": company.country,
            "buyer_type": buyer_type["type"] if buyer_type else None,
            "buyer_type_confidence": buyer_type["confidence"] if buyer_type else None,
            "evidence_summary": [{"assertion_id": a.id, "snippet": a.value.get("snippet"),
                                  "source_type": a.source_type, "checked_at": _iso(a.checked_at)}
                                 for a in ev[:EVIDENCE_SUMMARY_MAX]],
            "strongest_source_type": strongest,
            "last_activity": _iso(last_activity),
            "trust_level": trust_level,
            "contact_types": contact_types,
            "shipments_12m": shipments,
            "volume_kg_12m": kg,
            "origin_india": india,
            "origin_competitor": comp,
            "is_logistics": is_logistics,
            "sanctions_block": sanctions_block,
            "assertion_ids": heading_ids,
            "field_sources": doc_sources,
            "facts": [_fact(a) for a in heading_facts],
            "non_exportable_assertion_ids": sorted(i for i in heading_ids if i in set(non_exportable)),
            "hidden_assertion_ids": hidden_ids,
            "projection_version": PROJECTION_VERSION,
            "built_at": _iso(built_at),
        }
        tsv_text = " ".join(filter(None, [
            company.display_name, company.city or "", company.country,
            buyer_type["type"] if buyer_type else "", h,
            *(a.value.get("snippet") or "" for a in ev),
        ]))
        res.search_rows.append({
            "company_id": company.id, "hs_heading": h, "doc": doc, "tsv_text": tsv_text,
            "country": company.country, "buyer_type": buyer_type["type"] if buyer_type else None,
            "trust_level": trust_level, "last_activity": last_activity, "shipment_freq": shipments,
            "volume_score": volume_score, "origin_india": india, "origin_competitor": comp,
            "contact_types": contact_types, "is_logistics": is_logistics, "sanctions_block": sanctions_block,
            "identifier_hashes": identifier_hashes, "projection_version": PROJECTION_VERSION, "built_at": built_at,
        })
    return res


def project_company(repo: EvidenceRepo, company_id: str) -> ProjectionResult | None:
    """Rebuilds the docs of ``company_id`` (following merges). Returns what was written."""
    cid = str(company_id)
    with span("m09.project", {"company_id": cid}):
        company = repo.get_company(cid)
        if company is None:
            repo.delete_search_docs(cid)
            repo.delete_profile_doc(cid)
            return None
        if company.merged_into is not None:
            try:
                target = _resolve(repo, cid)
            except MergeCycle:
                _log.error("merge chain cycle; docs removed", extra={"company_id": cid})
                repo.delete_search_docs(cid)
                repo.delete_profile_doc(cid)
                raise
            repo.delete_search_docs(cid)
            repo.delete_profile_doc(cid)
            company = target
        assertions = repo.list_assertions(company.id, None, False)
        anchors = repo.anchors_of(company.id)
        res = build_projection(company, assertions, anchors, repo.suppressed)
        if res.purge or res.profile_row is None:
            repo.delete_search_docs(company.id)
            repo.delete_profile_doc(company.id)
            return res
        if res.closed:
            repo.delete_search_docs(company.id)
        else:
            repo.replace_search_docs(company.id, res.search_rows)
        repo.upsert_profile_doc(res.profile_row)
        return res
