"""M23 tests: parsing, matching, caching, rate limiting and the Unavailable contract.

No network: the M08 HTTP transport, WHOIS transport, MX lookup and licence register are faked.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, urlsplit

import pytest

from kp.m08_sources import (
    HttpResponse,
    SourceEntry,
    register_entries_loader,
    set_source_loader_for_testing,
    set_transport_for_testing,
    validate_entry,
)
from kp.m23_registry import (
    DomainSignals,
    FreemailList,
    MemoryCache,
    VENDOR_RATES,
    RateLimiter,
    RegistryMatch,
    Unavailable,
    VatResult,
    VendorRate,
    domain_signals,
    name_similarity,
    normalise_domain,
    rdap_bootstrap,
    registry_lookup,
    reset_whois_servers_for_testing,
    set_cache_for_testing,
    set_freemail_list_for_testing,
    set_limiter_for_testing,
    set_mx_lookup_for_testing,
    set_whois_transport_for_testing,
    vat_check,
)
from kp.m23_registry import registries as registries_mod
from kp.m23_registry import vendor as vendor_mod
from kp.m23_registry.domain import lookup_candidates, parse_whois_created
from kp.m23_registry.models import result_from_dict
from kp.m23_registry.vies import split_vat


def _src(sid: str, regions: list[str] | None = None, status: str = "active") -> SourceEntry:
    return validate_entry({
        "id": sid, "source_type": "registry", "can_store": False, "can_display": True, "can_export": True,
        "retention_days": None, "attribution_text": f"test {sid}", "personal_data_class": "none",
        "allowed_regions": regions or ["*"], "status": status, "notes": None,
    })


def _no_redis() -> Any:
    raise RuntimeError("no redis in tests")


FAST_RATES = {k: VendorRate(v.rate_class, 1000.0, v.max_concurrency) for k, v in VENDOR_RATES.items()}

SOURCES = [
    _src("registry.gleif"), _src("registry.gb.ch", ["GB"]), _src("registry.eu.vies", ["DE", "FR", "GR"]),
    _src("registry.opencorporates", status="disabled"), _src("domain.rdap"), _src("domain.whois"),
    _src("domain.dns"), _src("list.freemail"),
]


class _Http:
    def __init__(self) -> None:
        self.routes: dict[str, Any] = {}
        self.calls: list[str] = []

    def route(self, prefix: str, status: int, body: Any, headers: dict[str, str] | None = None) -> None:
        self.routes[prefix] = (status, body, headers or {})

    def __call__(self, method: str, url: str, headers: Any, timeout: float) -> HttpResponse:
        if url.endswith("/robots.txt"):
            return HttpResponse(url, 404, {}, b"")
        self.calls.append(url)
        for prefix in sorted(self.routes, key=len, reverse=True):
            if url.startswith(prefix):
                status, body, hdrs = self.routes[prefix]
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                return HttpResponse(url, status, {"content-type": "application/json", **hdrs}, raw)
        return HttpResponse(url, 404, {}, b"")


@pytest.fixture(autouse=True)
def _isolation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterable[_Http]:
    http = _Http()
    set_transport_for_testing(http)
    set_source_loader_for_testing(register_entries_loader(SOURCES))
    set_cache_for_testing(MemoryCache())

    # Generous in-process buckets by default; the rate-limit test installs the real rates.
    set_limiter_for_testing(RateLimiter(_no_redis, rates=FAST_RATES, max_wait_s=0.0))
    monkeypatch.setattr(vendor_mod, "assert_vendor_budget", lambda vendor: None)
    monkeypatch.setattr(vendor_mod, "record_cost", lambda **kw: None)
    monkeypatch.setattr(registries_mod, "_secret_or_none",
                        lambda name: "ch-key" if name == registries_mod.CH_SECRET else None)
    set_mx_lookup_for_testing(lambda d: (True, ("mx1." + d,)))
    set_whois_transport_for_testing(lambda server, q, t: "")
    reset_whois_servers_for_testing()
    rdap_bootstrap().set_map_for_testing({"com": ["https://rdap.example-registry.test/"]})
    set_freemail_list_for_testing(FreemailList(tmp_path / "freemail.txt"))
    yield http
    set_transport_for_testing(None)
    set_source_loader_for_testing(None)
    set_cache_for_testing(None)
    set_limiter_for_testing(None)
    set_mx_lookup_for_testing(None)
    set_whois_transport_for_testing(None)
    rdap_bootstrap().set_map_for_testing(None)
    set_freemail_list_for_testing(None)


GLEIF_BODY = {"data": [{
    "id": "213800ABCDEFGHIJKL12",
    "attributes": {
        "lei": "213800ABCDEFGHIJKL12",
        "entity": {
            "legalName": {"name": "ACME TRADING LIMITED"},
            "legalAddress": {"addressLines": ["1 High St"], "city": "London", "country": "GB", "postalCode": "E1"},
            "status": "ACTIVE", "registeredAs": "01234567", "registeredAt": {"id": "RA000585"},
        },
        "registration": {"status": "ISSUED"},
    },
}]}
CH_BODY = {"items": [
    {"title": "ACME TRADING LTD", "company_number": "01234567", "company_status": "active",
     "address_snippet": "1 High St, London", "date_of_creation": "2001-02-03"},
    {"title": "ACME HOLDINGS PLC", "company_number": "07654321", "company_status": "dissolved"},
]}


def test_name_similarity_ignores_legal_forms() -> None:
    assert name_similarity("Acme Trading Ltd.", "ACME TRADING LIMITED") == 1.0
    assert name_similarity("Société Générale S.A.", "Societe Generale") == 1.0
    assert name_similarity("Acme Trading", "Zenith Steel") < 0.5


def test_gb_lookup_prefers_companies_house_and_merges_lei(_isolation: _Http) -> None:
    _isolation.route("https://api.company-information.service.gov.uk/", 200, CH_BODY)
    _isolation.route("https://api.gleif.org/", 200, GLEIF_BODY)
    r = registry_lookup("Acme Trading Ltd", "gb")
    assert isinstance(r, RegistryMatch) and r.matched
    assert r.source_id == "registry.gb.ch" and r.status == "active" and r.name_similarity >= 0.9
    assert r.registry_id == "GB:ch:01234567" and r.lei == "213800ABCDEFGHIJKL12"
    assert r.anchors == {"lei": "213800ABCDEFGHIJKL12", "registry": "GB:ch:01234567"}
    q = parse_qs(urlsplit(_isolation.calls[0]).query)
    assert q["q"] == ["Acme Trading Ltd"]


def test_lookup_is_cached(_isolation: _Http) -> None:
    _isolation.route("https://api.gleif.org/", 200, GLEIF_BODY)
    first = registry_lookup("Acme Trading Limited", "DE")
    n = len(_isolation.calls)
    second = registry_lookup("ACME Trading Ltd", "DE")
    assert isinstance(first, RegistryMatch) and isinstance(second, RegistryMatch)
    assert len(_isolation.calls) == n  # same normalised name → cache hit
    assert second.query_name == "ACME Trading Ltd" and second.lei == first.lei


def test_dissolved_status_is_reported(_isolation: _Http) -> None:
    _isolation.route("https://api.company-information.service.gov.uk/", 200,
                     {"items": [{"title": "OLD CO LIMITED", "company_number": "00000001",
                                 "company_status": "dissolved", "date_of_cessation": "2019-01-01"}]})
    _isolation.route("https://api.gleif.org/", 200, {"data": []})
    r = registry_lookup("Old Co Ltd", "GB")
    assert isinstance(r, RegistryMatch) and r.matched and r.status == "dissolved"
    assert r.dissolved_on == "2019-01-01"


def test_no_match_only_when_every_registry_answered(_isolation: _Http) -> None:
    _isolation.route("https://api.gleif.org/", 200, {"data": []})
    r = registry_lookup("Nobody Here GmbH", "DE")
    assert isinstance(r, RegistryMatch) and not r.matched and r.sources_checked == ("registry.gleif",)


def test_failure_is_an_unavailable_value(_isolation: _Http) -> None:
    _isolation.route("https://api.gleif.org/", 503, b"down")
    r = registry_lookup("Acme", "DE")
    assert isinstance(r, Unavailable) and r.reason == "upstream_error"
    # Unavailable is never cached: the next call asks again.
    n = len(_isolation.calls)
    registry_lookup("Acme", "DE")
    assert len(_isolation.calls) == n + 1


def test_rate_limited_vendor_returns_unavailable(_isolation: _Http) -> None:
    set_limiter_for_testing(RateLimiter(_no_redis, max_wait_s=0.0))  # real vendor rates
    _isolation.route("https://api.gleif.org/", 200, {"data": []})
    assert isinstance(registry_lookup("First Co", "FR"), RegistryMatch)
    r = registry_lookup("Second Co", "FR")  # GLEIF bucket is 1/s with no wait budget
    assert isinstance(r, Unavailable) and r.reason == "rate_limited"


def test_invalid_input() -> None:
    bad_country = registry_lookup("Acme", "Germany")
    assert isinstance(bad_country, Unavailable) and bad_country.reason == "invalid_input"
    empty = registry_lookup("   ", "DE")
    assert isinstance(empty, Unavailable) and empty.reason == "invalid_input"
    assert isinstance(vat_check("123"), Unavailable)
    assert vat_check("US123456789") == Unavailable(source="registry.eu.vies", reason="no_registry", detail="US")


def test_vat_check(_isolation: _Http) -> None:
    _isolation.route("https://ec.europa.eu/taxation_customs/vies/rest-api/ms/DE/vat/123456789", 200,
                     {"isValid": True, "requestDate": "2026-09-28", "userError": "VALID", "name": "---",
                      "address": "---"})
    r = vat_check("de 123 456 789")
    assert isinstance(r, VatResult) and r.valid and r.vat == "DE123456789" and r.name is None
    assert r.anchors == {"vat": "DE123456789"}
    assert split_vat("GR 094259216") == ("EL", "094259216")


def test_vat_transient_error_is_unavailable(_isolation: _Http) -> None:
    _isolation.route("https://ec.europa.eu/taxation_customs/vies/rest-api/ms/FR/", 200,
                     {"isValid": False, "userError": "MS_UNAVAILABLE"})
    r = vat_check("FR12345678901")
    assert isinstance(r, Unavailable) and r.detail == "MS_UNAVAILABLE"


def test_domain_signals_from_rdap(_isolation: _Http) -> None:
    created = (date.today() - timedelta(days=800)).isoformat() + "T00:00:00Z"
    _isolation.route("https://rdap.example-registry.test/domain/acme.com", 200,
                     {"events": [{"eventAction": "registration", "eventDate": created},
                                 {"eventAction": "last changed", "eventDate": "2026-01-01T00:00:00Z"}]})
    s = domain_signals("https://www.shop.acme.com/contact")
    assert isinstance(s, DomainSignals)
    assert s.domain == "shop.acme.com" and s.registrable_domain == "acme.com"
    assert s.rdap_available and s.age_source == "rdap" and s.age_days in (799, 800, 801)
    assert s.has_mx is True and not s.is_freemail


def test_domain_signals_whois_fallback(_isolation: _Http) -> None:
    rdap_bootstrap().set_map_for_testing({"com": ["https://rdap.example-registry.test/"]})

    def whois(server: str, q: str, t: float) -> str:
        if server == "whois.iana.org":
            return "refer: whois.nic.xyz\n"
        return "Domain Name: ACME.XYZ\nCreation Date: 2015-06-01T10:00:00Z\n"

    set_whois_transport_for_testing(whois)
    s = domain_signals("acme.xyz")
    assert s.age_source == "whois" and not s.rdap_available and s.registered_on == "2015-06-01"


def test_freemail_domains_skip_registration_lookups(_isolation: _Http) -> None:
    s = domain_signals("someone@gmail.com")
    assert s.is_freemail and s.age_days is None and _isolation.calls == []


def test_mx_failure_is_none_not_false(_isolation: _Http) -> None:
    set_mx_lookup_for_testing(lambda d: (None, ()))
    _isolation.route("https://rdap.example-registry.test/", 404, b"")
    s = domain_signals("nomail.com")
    assert s.has_mx is None


def test_helpers() -> None:
    assert normalise_domain("Mail@Example.COM") == "example.com"
    assert lookup_candidates("a.acme.co.uk") == ["a.acme.co.uk", "acme.co.uk"]
    assert parse_whois_created("created:        01.02.2003\n") == date(2003, 2, 1)
    s = DomainSignals(domain="a.com", age_days=1, has_mx=True, is_freemail=False, rdap_available=True,
                      checked_at="2026-01-01T00:00:00+00:00", mx_hosts=("mx.a.com",))
    assert result_from_dict(s.to_dict()) == s


def test_freemail_list_file(tmp_path: Path) -> None:
    p = tmp_path / "fm.txt"
    p.write_text("# comment\nexample-free.test\n", encoding="utf-8")
    fl = FreemailList(p)
    assert fl.contains("example-free.test") and fl.contains("mail.example-free.test")
    assert fl.contains("gmail.com")  # core list always applies
    assert not fl.contains("acme.com")
    n = fl.write({"new-free.test"}, "https://upstream.test/list")
    assert fl.contains("new-free.test") and n >= 2
