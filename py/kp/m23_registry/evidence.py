"""Writing M23 results into the M09 evidence store (IF-09a), for callers that own a company.

- ``record_registry_match``  → ``registry.match`` assertion, plus ``lei`` / ``registry`` anchors when
  the name similarity is strong (the entity anchors M18 resolves on).
- ``record_vat_result``      → ``vat`` anchor for a valid number (there is no VAT attribute in the
  M09 vocabulary).
- ``record_domain_signals``  → ``domain.age_days``, ``domain.mx`` and ``domain.freemail``.

Everything runs in the caller's transaction; M09 emits EV-01 there.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from kp.m01_platform import get_logger
from kp.m09_evidence import AnchorConflict, AssertionId, AssertionIn, add_anchor, write_assertion

from .domain import SOURCE_DNS, SOURCE_RDAP, SOURCE_WHOIS
from .freemail import SOURCE_FREEMAIL
from .models import DomainSignals, RegistryMatch, VatResult

PRODUCER = "m23"
PRODUCER_VERSION = "1"
ANCHOR_MIN_SIMILARITY = 0.9  # [tunable] anchors are only attached for strong name matches

_log = get_logger("kp.m23_registry.evidence")


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _anchor(tx: Any, company_id: Any, kind: str, value: str) -> bool:
    try:
        add_anchor(tx, company_id, kind, value)
        return True
    except AnchorConflict:
        # Another company already owns this identifier: that is M18's merge-review territory.
        _log.warning("anchor belongs to another company; not attached",
                     extra={"company_id": str(company_id), "kind": kind})
        return False


def record_registry_match(tx: Any, company_id: Any, match: RegistryMatch) -> AssertionId | None:
    if not match.matched or match.source_id is None:
        return None
    at = _dt(match.checked_at)
    value: dict[str, Any] = {
        "legal_name": match.legal_name,
        "status": match.status,
        "name_similarity": match.name_similarity,
        "country": match.country,
    }
    for k in ("registry_id", "lei", "company_number", "incorporated_on", "dissolved_on", "address"):
        v = getattr(match, k)
        if v:
            value[k] = v
    aid = write_assertion(AssertionIn(
        subject_id=company_id, attribute="registry.match", value=value, source_id=match.source_id,
        source_ref={"url": match.url, "captured_at": match.checked_at, "query_name": match.query_name,
                    "query_country": match.query_country, "sources_checked": list(match.sources_checked)},
        observed_at=at, checked_at=at, confidence=max(0.0, min(1.0, match.name_similarity)),
        region=match.country if match.country and len(match.country) == 2 else None,
        producer=PRODUCER, producer_version=PRODUCER_VERSION,
    ), tx=tx)
    if aid is not None and match.name_similarity >= ANCHOR_MIN_SIMILARITY:
        for kind, v in match.anchors.items():
            _anchor(tx, company_id, kind, v)
    return aid


def record_vat_result(tx: Any, company_id: Any, result: VatResult) -> bool:
    """Attaches the VAT anchor for a valid number; returns whether it was attached."""
    if not result.valid:
        return False
    return _anchor(tx, company_id, "vat", result.vat)


def record_domain_signals(tx: Any, company_id: Any, s: DomainSignals, *, region: str | None = None) -> list[str]:
    at = _dt(s.checked_at)
    out: list[str] = []

    def _write(attribute: str, value: dict[str, Any], source_id: str, ref: dict[str, Any]) -> None:
        aid = write_assertion(AssertionIn(
            subject_id=company_id, attribute=attribute, value=value, source_id=source_id,
            source_ref={"domain": s.domain, "captured_at": s.checked_at, **ref}, observed_at=at, checked_at=at,
            confidence=1.0, region=region, producer=PRODUCER, producer_version=PRODUCER_VERSION,
        ), tx=tx)
        if aid is not None:
            out.append(aid)

    if s.age_days is not None and s.age_source is not None:
        _write("domain.age_days",
               {"age_days": s.age_days, "domain": s.registrable_domain or s.domain, "registered_on": s.registered_on},
               SOURCE_RDAP if s.age_source == "rdap" else SOURCE_WHOIS, {"method": s.age_source})
    if s.has_mx is not None:
        _write("domain.mx", {"has_mx": s.has_mx, "domain": s.domain}, SOURCE_DNS,
               {"method": "dns_mx", "hosts": list(s.mx_hosts)})
    _write("domain.freemail", {"is_freemail": s.is_freemail, "domain": s.domain}, SOURCE_FREEMAIL,
           {"method": "freemail_list"})
    return out
