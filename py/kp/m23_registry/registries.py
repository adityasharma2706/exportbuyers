"""Registry connectors: GLEIF (global), UK Companies House (GB) and OpenCorporates (optional).

Each ``search_*`` returns the candidate records for a name (possibly empty) or raises
``VendorFailure``. Only company-level fields are read; Companies House officer data (named-person
data in the licence register) is never requested.
"""
from __future__ import annotations

import base64
from typing import Any, Callable
from urllib.parse import quote, urlencode

from kp.m01_platform import KpError, get_secret

from .models import RegistryCandidate, RegistryStatus
from .vendor import VendorFailure, expect_ok, fetch_json, gate, note_call, require_source, source_active, text

SOURCE_GLEIF = "registry.gleif"
SOURCE_COMPANIES_HOUSE = "registry.gb.ch"
SOURCE_OPENCORPORATES = "registry.opencorporates"

GLEIF_API = "https://api.gleif.org/api/v1/lei-records"
CH_API = "https://api.company-information.service.gov.uk/search/companies"
CH_WEB = "https://find-and-update.company-information.service.gov.uk/company/"
OC_API = "https://api.opencorporates.com/v0.4/companies/search"

CH_SECRET = "COMPANIES_HOUSE_API_KEY"
OC_SECRET = "OPENCORPORATES_API_TOKEN"

MAX_CANDIDATES = 10  # [tunable]
# GLEIF registration-authority id of Companies House; lets a GLEIF record carry the CH anchor.
GLEIF_RA_COMPANIES_HOUSE = "RA000585"


def _secret_or_none(name: str) -> str | None:
    try:
        v = get_secret(name)
    except KpError:
        return None
    return v.strip() or None


def _items(v: Any) -> list[Any]:
    return v if isinstance(v, list) else []


def _dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


# ---- GLEIF --------------------------------------------------------------------------------

def _gleif_status(entity: dict[str, Any], registration: dict[str, Any]) -> RegistryStatus:
    expiration = _dict(entity.get("expiration"))
    reason = str(expiration.get("reason") or "").upper()
    if reason == "DISSOLVED":
        return "dissolved"
    status = str(entity.get("status") or "").upper()
    if status == "ACTIVE":
        return "active"
    if status == "INACTIVE":
        return "inactive"
    if str(registration.get("status") or "").upper() in ("RETIRED", "ANNULLED"):
        return "inactive"
    return "unknown"


def _gleif_address(addr: dict[str, Any]) -> str | None:
    parts = [*(str(x) for x in _items(addr.get("addressLines")) if x), addr.get("city"), addr.get("region"),
             addr.get("postalCode"), addr.get("country")]
    joined = ", ".join(str(p).strip() for p in parts if p and str(p).strip())
    return joined or None


def parse_gleif(body: Any) -> list[RegistryCandidate]:
    out: list[RegistryCandidate] = []
    for rec in _items(_dict(body).get("data"))[:MAX_CANDIDATES]:
        attrs = _dict(_dict(rec).get("attributes"))
        entity = _dict(attrs.get("entity"))
        registration = _dict(attrs.get("registration"))
        lei = text(attrs.get("lei")) or text(_dict(rec).get("id"))
        name = text(_dict(entity.get("legalName")).get("name"))
        if not lei or not name:
            continue
        addr = _dict(entity.get("legalAddress"))
        country = text(addr.get("country")) or text(entity.get("jurisdiction"))
        country = country[:2].upper() if country else None
        registered_as = text(entity.get("registeredAs"))
        ra_id = text(_dict(entity.get("registeredAt")).get("id"))
        registry_id = None
        if registered_as and ra_id == GLEIF_RA_COMPANIES_HOUSE:
            registry_id = f"GB:ch:{registered_as}"
        others = tuple(n for n in (text(_dict(o).get("name")) for o in _items(entity.get("otherNames"))) if n)
        others += tuple(n for n in (text(_dict(o).get("name")) for o in _items(entity.get("transliteratedOtherNames")))
                        if n)
        creation = text(entity.get("creationDate"))
        out.append(RegistryCandidate(
            source_id=SOURCE_GLEIF, legal_name=name, status=_gleif_status(entity, registration), country=country,
            registry_id=registry_id, lei=lei.upper(), company_number=registered_as, address=_gleif_address(addr),
            incorporated_on=creation[:10] if creation else None,
            url=f"https://search.gleif.org/#/record/{lei.upper()}", other_names=others,
        ))
    return out


def search_gleif(name: str, country: str) -> list[RegistryCandidate]:
    require_source(SOURCE_GLEIF, country)
    gate(SOURCE_GLEIF, "gleif")
    params = {"filter[fulltext]": name, "filter[entity.legalAddress.country]": country,
              "page[size]": str(MAX_CANDIDATES)}
    r = fetch_json(SOURCE_GLEIF, f"{GLEIF_API}?{urlencode(params)}")
    note_call("gleif", "lei_search")
    expect_ok(SOURCE_GLEIF, r)
    return parse_gleif(r.body)


# ---- Companies House ----------------------------------------------------------------------

_CH_STATUS: dict[str, RegistryStatus] = {
    "active": "active",
    "open": "active",
    "dissolved": "dissolved",
    "closed": "dissolved",
    "converted-closed": "dissolved",
    "removed": "dissolved",
    "liquidation": "inactive",
    "receivership": "inactive",
    "administration": "inactive",
    "insolvency-proceedings": "inactive",
    "voluntary-arrangement": "inactive",
    "registered": "active",
}


def parse_companies_house(body: Any) -> list[RegistryCandidate]:
    out: list[RegistryCandidate] = []
    for it in _items(_dict(body).get("items"))[:MAX_CANDIDATES]:
        item = _dict(it)
        number = text(item.get("company_number"))
        title = text(item.get("title"))
        if not number or not title:
            continue
        status = _CH_STATUS.get(str(item.get("company_status") or "").lower(), "unknown")
        created = text(item.get("date_of_creation"))
        ceased = text(item.get("date_of_cessation"))
        out.append(RegistryCandidate(
            source_id=SOURCE_COMPANIES_HOUSE, legal_name=title, status=status, country="GB",
            registry_id=f"GB:ch:{number}", company_number=number, address=text(item.get("address_snippet")),
            incorporated_on=created[:10] if created else None, dissolved_on=ceased[:10] if ceased else None,
            url=CH_WEB + quote(number),
        ))
    return out


def search_companies_house(name: str) -> list[RegistryCandidate]:
    require_source(SOURCE_COMPANIES_HOUSE, "GB")
    key = _secret_or_none(CH_SECRET)
    if key is None:
        raise VendorFailure(SOURCE_COMPANIES_HOUSE, "not_configured", CH_SECRET)
    gate(SOURCE_COMPANIES_HOUSE, "companies_house")
    auth = base64.b64encode(f"{key}:".encode("utf-8")).decode("ascii")
    r = fetch_json(SOURCE_COMPANIES_HOUSE, f"{CH_API}?{urlencode({'q': name, 'items_per_page': MAX_CANDIDATES})}",
                   headers={"authorization": f"Basic {auth}"})
    note_call("companies_house", "company_search")
    expect_ok(SOURCE_COMPANIES_HOUSE, r, allow=(404,))
    return [] if r.status == 404 else parse_companies_house(r.body)


# ---- OpenCorporates (optional) ------------------------------------------------------------

def _oc_status(company: dict[str, Any]) -> RegistryStatus:
    if text(company.get("dissolution_date")):
        return "dissolved"
    s = str(company.get("current_status") or "").lower()
    if not s:
        return "unknown"
    if any(w in s for w in ("dissolved", "struck off", "removed", "closed", "cancelled", "deregistered")):
        return "dissolved"
    if any(w in s for w in ("liquidation", "inactive", "dormant", "administration", "receivership", "suspended")):
        return "inactive"
    if any(w in s for w in ("active", "registered", "good standing", "live", "current")):
        return "active"
    return "unknown"


def _oc_registry_id(jurisdiction: str, number: str) -> str:
    j = jurisdiction.lower()
    cc = j.split("_", 1)[0].upper()
    reg = "ch" if j == "gb" else j
    return f"{cc}:{reg}:{number}"


def parse_opencorporates(body: Any) -> list[RegistryCandidate]:
    out: list[RegistryCandidate] = []
    companies = _items(_dict(_dict(body).get("results")).get("companies"))
    for wrapper in companies[:MAX_CANDIDATES]:
        c = _dict(_dict(wrapper).get("company"))
        name = text(c.get("name"))
        number = text(c.get("company_number"))
        jur = text(c.get("jurisdiction_code"))
        if not name or not number or not jur:
            continue
        inc = text(c.get("incorporation_date"))
        dis = text(c.get("dissolution_date"))
        prev = tuple(n for n in (text(_dict(p).get("company_name")) for p in _items(c.get("previous_names"))) if n)
        out.append(RegistryCandidate(
            source_id=SOURCE_OPENCORPORATES, legal_name=name, status=_oc_status(c),
            country=jur.split("_", 1)[0].upper()[:2], registry_id=_oc_registry_id(jur, number), company_number=number,
            address=text(c.get("registered_address_in_full")), incorporated_on=inc[:10] if inc else None,
            dissolved_on=dis[:10] if dis else None, url=text(c.get("opencorporates_url")), other_names=prev,
        ))
    return out


def opencorporates_enabled() -> bool:
    return source_active(SOURCE_OPENCORPORATES) and _secret_or_none(OC_SECRET) is not None


def search_opencorporates(name: str, country: str) -> list[RegistryCandidate]:
    require_source(SOURCE_OPENCORPORATES, country)
    token = _secret_or_none(OC_SECRET)
    if token is None:
        raise VendorFailure(SOURCE_OPENCORPORATES, "not_configured", OC_SECRET)
    gate(SOURCE_OPENCORPORATES, "opencorporates")
    params = {"q": name, "country_code": country.lower(), "per_page": str(MAX_CANDIDATES), "api_token": token}
    r = fetch_json(SOURCE_OPENCORPORATES, f"{OC_API}?{urlencode(params)}", log_url=False)
    note_call("opencorporates", "company_search")
    expect_ok(SOURCE_OPENCORPORATES, r)
    return parse_opencorporates(r.body)


# Search functions by source id, in the order they are consulted for a country.
Searcher = Callable[[str, str], list[RegistryCandidate]]


def searchers_for(country: str) -> list[tuple[str, Searcher]]:
    out: list[tuple[str, Searcher]] = []
    if country == "GB":
        out.append((SOURCE_COMPANIES_HOUSE, lambda n, c: search_companies_house(n)))
    out.append((SOURCE_GLEIF, search_gleif))
    if opencorporates_enabled():
        out.append((SOURCE_OPENCORPORATES, search_opencorporates))
    return out
