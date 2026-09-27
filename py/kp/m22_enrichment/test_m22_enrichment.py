"""M22 tests: extraction rules, masking, domain guess and the end-to-end write path over M09's
in-memory repo (no network, no database, no DNS)."""
from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timezone
from typing import Any, Iterable

import pytest

from kp.m08_sources import register_entries_loader, set_source_loader_for_testing, validate_entry
from kp.m09_evidence import (
    AssertionIn,
    MemoryEvidenceRepo,
    contact_value_hash,
    create_company,
    get_assertions,
    set_suppression_checker,
    write_assertion,
)
from kp.m22_enrichment import (
    ContactPage,
    EnrichDeps,
    MxResult,
    classify_email,
    contact_links,
    enrich_company,
    extract_contacts,
    guess_domain,
    idempotency_key,
    mask_email,
    should_enrich,
    whatsapp_link,
)

T0 = datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)

HOME = """<html><head><title>Acme Trading GmbH</title>
<script type="application/ld+json">{"@type":"Organization","name":"Acme",
 "address":{"@type":"PostalAddress","streetAddress":"Hafenstrasse 12","postalCode":"20457",
 "addressLocality":"Hamburg","addressCountry":"DE"}}</script></head>
<body><a href="/kontakt">Kontakt</a> <a href="/about-us">About</a> <a href="/products/steel">Steel</a>
<a href="mailto:sales@acme.de">Sales</a> <a href="mailto:john.smith@acme.de">John</a>
<a href="mailto:someone@gmail.com">x</a>
<a href="https://wa.me/4915123456789">WhatsApp</a>
<form role="search" action="/search"><input type="search" name="q"></form>
</body></html>"""

CONTACT = """<html><body><h1>Contact</h1>
<p>Tel: <a href="tel:+49 30 123456">+49 30 123456</a></p>
<p>Fax: +49 30 123457</p>
<p>Write to info [at] acme.de or export@acme.de</p>
<address>Acme Trading GmbH<br>Hafenstrasse 12<br>20457 Hamburg<br>Tel +49 30 123456</address>
<form action="/send" method="post"><input type="email" name="email"><textarea name="msg"></textarea></form>
</body></html>"""


def _src() -> Any:
    return validate_entry({
        "id": "web.crawl", "source_type": "website", "can_store": True, "can_display": True, "can_export": True,
        "retention_days": 365, "attribution_text": "Source: website", "personal_data_class": "business_contact",
        "allowed_regions": ["*"], "status": "active",
    })


@pytest.fixture(autouse=True)
def _sources() -> Iterable[None]:
    set_source_loader_for_testing(register_entries_loader([_src()]))
    set_suppression_checker(None)
    yield
    set_source_loader_for_testing(None)
    set_suppression_checker(None)


def _pages() -> list[ContactPage]:
    return [
        ContactPage(url="https://acme.de/", html=HOME, fetched_at=T0, raw_object_id="raw-1", sha256="a" * 64),
        ContactPage(url="https://acme.de/kontakt", html=CONTACT, fetched_at=T0, raw_object_id="raw-2", sha256="b" * 64),
    ]


class FakeCrawler:
    def __init__(self, pages: list[ContactPage]) -> None:
        self.pages = pages
        self.calls: list[str] = []

    def crawl_contacts(self, homepage: str, domain: str) -> list[ContactPage]:
        self.calls.append(homepage)
        return self.pages


class FakeDns:
    def __init__(self, mx: dict[str, bool | None], resolves: bool | None = True) -> None:
        self.mx = mx
        self.resolves = resolves

    def mx_lookup(self, domain: str) -> MxResult:
        return MxResult(domain=domain, has_mx=self.mx.get(domain), hosts=("mx.acme.de",) if self.mx.get(domain) else ())

    def domain_resolves(self, domain: str) -> bool | None:
        return self.resolves


def _deps(repo: MemoryEvidenceRepo, *, mx: bool | None = True, suppressed: set[tuple[str, str]] | None = None,
          pages: list[ContactPage] | None = None, resolves: bool | None = True) -> EnrichDeps:
    blocked = suppressed or set()
    crawler = FakeCrawler(_pages() if pages is None else pages)
    return EnrichDeps(crawler=lambda: crawler, dns=FakeDns({"acme.de": mx}, resolves), tx=lambda: nullcontext(repo),
                      is_suppressed=lambda kind, raw: (kind, raw) in blocked, now=lambda: T0)


# ---- unit ---------------------------------------------------------------------------------------

def test_role_vs_personal_email() -> None:
    assert classify_email("sales@acme.de", "acme.de") == "role"
    assert classify_email("Enquiries@shop.acme.de", "acme.de") == "role"
    assert classify_email("john.smith@acme.de", "acme.de") == "personal"
    assert classify_email("info@other.com", "acme.de") is None


def test_masks_and_keys() -> None:
    assert mask_email("sales@acme.de") == "s***@acme.de"
    assert idempotency_key("c1", T0) == "enrich:c1:2026-09-01"
    assert should_enrich(["product_evidence"]) and should_enrich(["domain", "contact"])
    assert not should_enrich(["contact", "trust"])


def test_whatsapp_links() -> None:
    assert whatsapp_link("https://wa.me/4915123456789") == "https://wa.me/4915123456789"
    assert whatsapp_link("https://api.whatsapp.com/send?phone=4915123456789&text=hi") == "https://wa.me/4915123456789"
    assert whatsapp_link("https://wa.me/12") is None


def test_contact_links_prioritise_contact_pages() -> None:
    hrefs = ["/products/a", "/about-us", "/kontakt", "mailto:x@acme.de", "https://other.com/contact", "/impressum"]
    assert contact_links("https://acme.de/", hrefs, "acme.de", 3) == [
        "https://acme.de/kontakt", "https://acme.de/impressum", "https://acme.de/about-us"]


def test_extraction_rules() -> None:
    cands, personal = extract_contacts(_pages(), "acme.de", "DE")
    by_kind: dict[str, set[str]] = {}
    for c in cands:
        by_kind.setdefault(c.kind, set()).add(c.value)
    assert by_kind["role_email"] == {"sales@acme.de", "info@acme.de", "export@acme.de"}
    assert personal == 1                                  # john.smith@ discarded, only counted
    assert "+4930123456" in by_kind["phone"]
    assert "+4930123457" not in by_kind["phone"]          # labelled fax
    assert by_kind["whatsapp"] == {"https://wa.me/4915123456789"}
    assert by_kind["form_url"] == {"https://acme.de/kontakt"}   # the search form does not count
    assert by_kind["address"] == {"Hafenstrasse 12, 20457, Hamburg, DE"}


def test_guess_domain_skips_marketplaces() -> None:
    urls = ["https://www.alibaba.com/x", "https://acme.de/p1", "https://acme.de/p2", "https://other.fr/"]
    assert guess_domain(urls) == "acme.de"
    assert guess_domain(["https://www.amazon.com/x"]) is None


# ---- end to end ---------------------------------------------------------------------------------

def _company(repo: MemoryEvidenceRepo, domain: str | None = "acme.de") -> str:
    return create_company(repo, display_name="Acme Trading GmbH", country="DE", primary_domain=domain)


def test_enrich_writes_contacts_with_source_and_date() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo)
    res = enrich_company(cid, _deps(repo))
    assert res.outcome == "enriched"
    assert set(res.contact_types) == {"website", "phone", "role_email", "form_url", "address", "whatsapp"}
    rows = get_assertions(cid, None, tx=repo)
    contacts = [a for a in rows if a.attribute.startswith("contact.")]
    assert contacts
    for a in contacts:
        assert a.source_id == "web.crawl" and a.source_type == "website"
        assert a.source_ref["url"].startswith("https://acme.de/") and a.source_ref["captured_at"]
        assert a.checked_at is not None
        assert "value" not in a.value and a.value["display_mask"]
        cv = repo.contact_values[a.id]
        assert cv.value_hash == a.value["value_hash"] == contact_value_hash(a.attribute.split(".", 1)[1], cv.value)
    assert not any("john.smith" in cv.value for cv in repo.contact_values.values())
    mx = [a for a in rows if a.attribute == "domain.mx"]
    assert mx and mx[0].value["has_mx"] is True


def test_no_mx_marks_emails_invalid_and_rerun_is_idempotent() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo)
    res = enrich_company(cid, _deps(repo, mx=False))
    emails = [c for c in res.contacts if c.kind == "role_email"]
    assert emails and all(c.deliverability == "invalid" for c in emails)
    assert "role_email" not in res.contact_types
    before = len(repo.assertions)
    enrich_company(cid, _deps(repo, mx=False))
    assert len(repo.assertions) == before              # identical values only refresh checked_at


def test_suppressed_values_are_not_written() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo)
    res = enrich_company(cid, _deps(repo, suppressed={("email", "sales@acme.de")}))
    assert any(c.outcome == "suppressed" and c.kind == "role_email" for c in res.contacts)
    assert "sales@acme.de" not in {cv.value for cv in repo.contact_values.values()}


def test_suppressed_or_unresolvable_domain_stops_before_crawl() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo)
    assert enrich_company(cid, _deps(repo, suppressed={("domain", "acme.de")})).outcome == "domain_suppressed"
    assert enrich_company(cid, _deps(repo, resolves=False)).outcome == "domain_unresolvable"
    assert not repo.contact_values


def test_domain_guessed_from_evidence() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo, domain=None)
    write_assertion(AssertionIn(
        subject_id=cid, attribute="product_evidence",
        value={"hs_heading": "7208", "snippet": "We import hot-rolled steel", "url": "https://acme.de/products"},
        source_id="web.crawl", source_ref={"url": "https://acme.de/products", "captured_at": T0.isoformat()},
        confidence=0.9, producer="test", producer_version="1", llm_assisted=True,
    ), tx=repo)
    res = enrich_company(cid, _deps(repo))
    assert res.domain == "acme.de" and res.domain_source == "evidence_guess"
    assert res.outcome == "enriched"
