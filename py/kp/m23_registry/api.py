"""IF-23a — on-demand registry, VAT and domain lookups with caching.

    registry_lookup(name, country) -> RegistryMatch | Unavailable   # Companies House (GB), GLEIF, OpenCorporates
    vat_check(vat) -> VatResult | Unavailable                       # VIES (EU)
    domain_signals(domain) -> DomainSignals                         # age, MX, free-mail, rdap_available

Registry selection: the registries for the country are consulted in order (Companies House first
for GB, then GLEIF, then OpenCorporates if enabled). As soon as a candidate reaches
``STRONG_MATCH`` similarity the search stops; otherwise the best candidate across all answering
registries is returned. The result is ``Unavailable`` only when there is no usable candidate and
at least one registry failed, so "not found" is only claimed when every registry answered.
"""
from __future__ import annotations

import re

from kp.m01_platform import KpError, get_logger, span

from .cache import DOMAIN_TTL_S, PARTIAL_DOMAIN_TTL_S, REGISTRY_TTL_S, cache_get, cache_key, cache_put
from .domain import age_days_from, mx_lookup, normalise_domain, registration_lookup
from .freemail import is_freemail
from .models import DomainSignals, RegistryCandidate, RegistryMatch, Unavailable, VatResult, iso, utcnow
from .names import best_similarity, normalise_name
from .registries import searchers_for
from .vendor import VendorFailure
from .vies import SOURCE_VIES, VIES_MEMBER_STATES, check_vies, split_vat

_log = get_logger("kp.m23_registry.api")

STRONG_MATCH = 0.9     # [tunable] same threshold M24 uses for registered_entity = pass
MIN_MATCH = 0.5        # [tunable] below this a candidate is not reported as a match at all
_CC_RE = re.compile(r"^[A-Z]{2}$")
_STATUS_RANK = {"active": 3, "inactive": 2, "dissolved": 1, "unknown": 0}


def _country(country: str) -> str:
    cc = (country or "").strip().upper()
    if cc == "UK":
        cc = "GB"
    if cc == "EL":
        cc = "GR"
    return cc


def _score(query: str, c: RegistryCandidate) -> float:
    return best_similarity(query, [c.legal_name, *c.other_names])


def _pick(query: str, cands: list[tuple[float, RegistryCandidate]]) -> tuple[float, RegistryCandidate] | None:
    """Highest similarity; ties prefer active records, then the registry consulted first (the national
    register is authoritative for its own companies), then the earlier result within it."""
    if not cands:
        return None
    best_i = max(range(len(cands)), key=lambda i: (cands[i][0], _STATUS_RANK.get(cands[i][1].status, 0), -i))
    return cands[best_i]


def _to_match(name: str, cc: str, sim: float, c: RegistryCandidate, checked: list[str]) -> RegistryMatch:
    return RegistryMatch(
        matched=True, query_name=name, query_country=cc, checked_at=iso(utcnow()), sources_checked=tuple(checked),
        source_id=c.source_id, legal_name=c.legal_name, status=c.status, name_similarity=sim, country=c.country,
        registry_id=c.registry_id, lei=c.lei, company_number=c.company_number, address=c.address,
        incorporated_on=c.incorporated_on, dissolved_on=c.dissolved_on, url=c.url,
    )


def _merge_lei(best: RegistryMatch, gleif_hits: list[tuple[float, RegistryCandidate]]) -> RegistryMatch:
    """A Companies House / OpenCorporates match gains the LEI of a GLEIF record for the same entity."""
    if best.lei or not best.registry_id:
        return best
    for _, g in gleif_hits:
        if g.lei and g.registry_id and g.registry_id.upper() == best.registry_id.upper():
            return RegistryMatch(**{**best.to_dict(), "lei": g.lei, "sources_checked": best.sources_checked})
    return best


def _lookup_uncached(name: str, cc: str) -> RegistryMatch | Unavailable:
    checked: list[str] = []
    failures: list[VendorFailure] = []
    scored: list[tuple[float, RegistryCandidate]] = []
    for source_id, search in searchers_for(cc):
        try:
            cands = search(name, cc)
        except VendorFailure as e:
            failures.append(e)
            _log.info("registry search failed", extra={"source": source_id, "reason": e.reason, "detail": e.detail})
            continue
        checked.append(source_id)
        scored.extend((_score(name, c), c) for c in cands)
        top = _pick(name, scored)
        if top is not None and top[0] >= STRONG_MATCH:
            # One more pass is still worth it for GB: GLEIF may add the LEI of the CH record.
            if source_id != "registry.gb.ch":
                break
    top = _pick(name, [sc for sc in scored if sc[0] >= MIN_MATCH])
    if top is None:
        if failures:
            if len(failures) == 1 and not checked:
                return failures[0].as_unavailable()
            return Unavailable(source="registry", reason=failures[0].reason,
                               detail=",".join(f"{f.source}:{f.reason}" for f in failures))
        return RegistryMatch(matched=False, query_name=name, query_country=cc, checked_at=iso(utcnow()),
                             sources_checked=tuple(checked))
    sim, cand = top
    match = _to_match(name, cc, sim, cand, checked)
    return _merge_lei(match, [sc for sc in scored if sc[1].source_id == "registry.gleif"])


def registry_lookup(name: str, country: str) -> RegistryMatch | Unavailable:
    """IF-23a. Best registry record for ``name`` in ``country`` (ISO 3166-1 alpha-2). Cached 30 days."""
    cc = _country(country)
    clean = " ".join((name or "").split())
    if not _CC_RE.match(cc):
        return Unavailable(source="registry", reason="invalid_input", detail="country must be ISO alpha-2")
    if not normalise_name(clean) or len(clean) > 300:
        return Unavailable(source="registry", reason="invalid_input", detail="name is empty or too long")
    key = cache_key("reg", cc, normalise_name(clean))
    hit = cache_get(key)
    if isinstance(hit, RegistryMatch):
        # Similarity is recomputed for this exact spelling; the record itself is what was cached.
        if hit.matched and hit.legal_name:
            sim = max(hit.name_similarity if hit.query_name == clean else 0.0,
                      best_similarity(clean, [hit.legal_name]))
            return RegistryMatch(**{**hit.to_dict(), "query_name": clean, "name_similarity": sim,
                                    "sources_checked": hit.sources_checked})
        return RegistryMatch(**{**hit.to_dict(), "query_name": clean, "sources_checked": hit.sources_checked})
    with span("m23.registry_lookup", {"country": cc}):
        result = _lookup_uncached(clean, cc)
    cache_put(key, result, REGISTRY_TTL_S)
    return result


def vat_check(vat: str) -> VatResult | Unavailable:
    """IF-23a. VIES check of an EU VAT number (with its country prefix). Cached 30 days."""
    parts = split_vat(vat)
    if parts is None:
        return Unavailable(source=SOURCE_VIES, reason="invalid_input", detail="expected a country prefix and number")
    cc, number = parts
    if cc not in VIES_MEMBER_STATES:
        return Unavailable(source=SOURCE_VIES, reason="no_registry", detail=cc)
    key = cache_key("vat", cc, number)
    hit = cache_get(key)
    if isinstance(hit, VatResult):
        return hit
    with span("m23.vat_check", {"country": cc}):
        try:
            result: VatResult | Unavailable = check_vies(cc, number)
        except VendorFailure as e:
            result = e.as_unavailable()
    cache_put(key, result, REGISTRY_TTL_S)
    return result


def domain_signals(domain: str) -> DomainSignals:
    """IF-23a. Age, MX, free-mail and RDAP availability for a domain (or URL / e-mail). Cached 7 days.

    Raises ``KpError(VALIDATION)`` only for input that is not a domain at all; vendor failures show
    up as ``age_days=None`` / ``has_mx=None``.
    """
    d = normalise_domain(domain)
    key = cache_key("dom", d)
    hit = cache_get(key)
    if isinstance(hit, DomainSignals):
        return hit
    with span("m23.domain_signals"):
        free = is_freemail(d)
        has_mx, hosts = mx_lookup(d)
        age: int | None = None
        registered_on: str | None = None
        age_source = None
        registrable: str | None = None
        rdap_available = False
        authoritative = False
        if free:
            # Free-mail providers are not the company; their registration age says nothing about it.
            authoritative = True
        else:
            try:
                lookup, rdap_available = registration_lookup(d)
            except KpError as e:  # licence-register or helper errors: age stays unknown
                _log.info("registration lookup failed", extra={"domain": d, "code": e.code})
            else:
                authoritative = lookup.outcome in ("found", "not_found", "no_service")
                registrable = lookup.name
                if lookup.created is not None:
                    age = age_days_from(lookup.created)
                    registered_on = lookup.created.isoformat()
                    age_source = lookup.via
        result = DomainSignals(
            domain=d, age_days=age, has_mx=has_mx, is_freemail=free, rdap_available=rdap_available,
            checked_at=iso(utcnow()), registered_on=registered_on, age_source=age_source,
            registrable_domain=registrable, mx_hosts=hosts,
        )
    ttl = DOMAIN_TTL_S if (has_mx is not None and authoritative) else PARTIAL_DOMAIN_TTL_S
    cache_put(key, result, ttl)
    return result
