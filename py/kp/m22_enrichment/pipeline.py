"""M22 enrichment for one company (LLD M22 steps 1–6).

1. Domain: the company's ``primary_domain``, else the most frequent usable domain among the URLs of
   its ``product_evidence`` assertions. Marketplace/free-mail domains and prohibited hosts are never
   guessed. The domain itself must pass IF-10c and resolve in DNS before anything is fetched.
2. Crawl the homepage plus contact / legal-notice / about pages (``ContactCrawler``, M08-landed).
3. Extract website, role emails, phones, address, contact-form URLs and ``wa.me`` links
   (``extract.py``; personal-looking mailboxes are discarded).
4. Own MX lookup → ``domain.mx``. Role emails on a domain without MX get ``deliverability: invalid``.
5. Each value → ``write_assertion(contact.<kind>, value={value_hash, display_mask, …},
   source_ref={url, captured_at, …})`` and a ``contact_value`` row (``put_contact_value``), in one
   transaction. ``display_mask`` (e.g. ``s***@acme.de``) is only for type/availability display.
6. Every value is checked against IF-10c (``is_suppressed``) before it is written; M09 checks the
   value hash again inside the transaction.

Crawling and DNS happen outside the database transaction; only the writes are transactional.
"""
from __future__ import annotations

from collections import Counter
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Protocol
from urllib.parse import urlsplit

from kp.m01_platform import KpError, get_logger, span
from kp.m08_sources import is_prohibited_host
from kp.m09_evidence import (
    AssertionIn,
    CompanyNotFound,
    contact_value_hash,
    get_assertions,
    open_repo,
    put_contact_value,
    resolve_company_id,
    get_company,
    write_assertion,
)
from kp.m10_policy import is_suppressed as policy_is_suppressed
from kp.m18_resolution import is_excluded_anchor_domain, normalise_domain

from .crawl import ContactCrawler
from .dns_check import DnsChecker, default_dns_checker
from .extract import extract_contacts
from .models import (
    ENRICH_V,
    PRODUCER,
    PRODUCER_VERSION,
    WEB_SOURCE_ID,
    ContactCandidate,
    ContactPage,
    ContactResult,
    EnrichResult,
    MxResult,
)

_log = get_logger("kp.m22_enrichment.pipeline")

TxFactory = Callable[[], AbstractContextManager[Any]]


class ContactSiteCrawler(Protocol):
    def crawl_contacts(self, homepage: str, domain: str) -> list[ContactPage]: ...


@dataclass
class EnrichDeps:
    crawler: Callable[[], ContactSiteCrawler] | None = None
    dns: DnsChecker | None = None
    tx: TxFactory | None = None
    is_suppressed: Callable[[str, str], bool] | None = None
    now: Callable[[], datetime] | None = None

    def get_crawler(self) -> ContactSiteCrawler:
        return self.crawler() if self.crawler is not None else ContactCrawler()

    def get_dns(self) -> DnsChecker:
        return self.dns or default_dns_checker()

    def open_tx(self) -> AbstractContextManager[Any]:
        return self.tx() if self.tx is not None else open_repo()

    def suppressed(self, kind: str, raw: str) -> bool:
        return (self.is_suppressed or policy_is_suppressed)(kind, raw)

    def utcnow(self) -> datetime:
        return (self.now or (lambda: datetime.now(timezone.utc)))()


# ---- display masks -------------------------------------------------------------------------------

def _mask_label(s: str) -> str:
    return (s[:1] + "***") if s else "***"


def mask_domain(domain: str) -> str:
    """``acme.de`` → ``a***.de``."""
    labels = domain.split(".")
    if len(labels) < 2:
        return _mask_label(domain)
    return ".".join([_mask_label(labels[0])] + labels[1:])


def mask_email(email: str) -> str:
    """``sales@acme.de`` → ``s***@acme.de`` (the LLD's example)."""
    local, _, dom = email.partition("@")
    return f"{_mask_label(local)}@{dom}"


def mask_phone(e164: str) -> str:
    """``+4930123456789`` → ``+49 *** **89`` (country code and the last two digits only)."""
    digits = e164.lstrip("+")
    try:
        import phonenumbers

        cc = str(phonenumbers.parse(e164, None).country_code)
    except Exception:  # noqa: BLE001 — masking must never fail a write
        cc = digits[:2]
    return f"+{cc} *** **{digits[-2:]}" if len(digits) > 4 else "+*** ***"


def display_mask(kind: str, value: str, domain: str) -> str:
    if kind == "role_email":
        return mask_email(value)
    if kind == "phone":
        return mask_phone(value)
    if kind == "whatsapp":
        return "wa.me/" + mask_phone("+" + value.rsplit("/", 1)[-1])
    if kind == "website":
        return mask_domain(domain)
    if kind == "form_url":
        return f"{mask_domain(domain)}/***"
    if kind == "address":
        return (value[:3] + "***") if len(value) > 3 else "***"
    return "***"


# ---- step 1: domain ------------------------------------------------------------------------------

def _usable_domain(raw: str | None) -> str | None:
    if not raw:
        return None
    host = raw
    if "://" in raw:
        try:
            host = urlsplit(raw).hostname or ""
        except ValueError:
            return None
    d = normalise_domain(host)
    if not d or "." not in d or is_excluded_anchor_domain(d) or is_prohibited_host(host):
        return None
    return d


def guess_domain(evidence_urls: Iterable[str]) -> str | None:
    """The most frequent usable domain among evidence URLs (first seen wins a tie)."""
    counts: Counter[str] = Counter()
    first: dict[str, int] = {}
    for i, url in enumerate(evidence_urls):
        d = _usable_domain(url)
        if d:
            counts[d] += 1
            first.setdefault(d, i)
    if not counts:
        return None
    return sorted(counts, key=lambda d: (-counts[d], first[d]))[0]


def _evidence_urls(assertions: Iterable[Any]) -> list[str]:
    urls: list[str] = []
    for a in assertions:
        if getattr(a, "polarity", "positive") != "positive":
            continue
        for u in (a.value.get("url"), a.source_ref.get("url")):
            if isinstance(u, str) and u:
                urls.append(u)
        for extra in a.source_ref.get("additional_snippets") or []:
            if isinstance(extra, dict) and isinstance(extra.get("url"), str):
                urls.append(extra["url"])
    return urls


# ---- steps 4–6 -----------------------------------------------------------------------------------

def _suppression_probe(c: ContactCandidate) -> tuple[str, str] | None:
    """(IF-10c identifier kind, raw value) to check for a candidate; ``None`` for addresses, which
    are not identifiers (M09 still checks the company id)."""
    if c.kind == "role_email":
        return ("email", c.value)
    if c.kind == "phone":
        return ("phone", c.value)
    if c.kind == "whatsapp":
        return ("phone", "+" + c.value.rsplit("/", 1)[-1])
    if c.kind in ("website", "form_url"):
        return ("domain", c.value)
    return None


def _is_suppressed(deps: EnrichDeps, c: ContactCandidate) -> bool:
    probe = _suppression_probe(c)
    if probe is None:
        return False
    try:
        return deps.suppressed(*probe)
    except KpError as e:
        if e.code == "VALIDATION":
            return True   # an identifier we cannot normalise is not worth the risk (as M20)
        raise


def _email_domain(email: str) -> str:
    return email.rsplit("@", 1)[1].lower()


def _deliverability(c: ContactCandidate, mx: dict[str, MxResult]) -> str | None:
    if c.kind == "role_email":
        res = mx.get(_email_domain(c.value))
        if res is not None and res.has_mx is False:
            return "invalid"
        return "unknown"            # mailbox verification is M25's job
    if c.kind in ("phone", "whatsapp"):
        return "valid"              # only libphonenumber-valid numbers are extracted (M25's phone rule)
    return None


def _write_contacts(company_id: str, country: str, domain: str, candidates: list[ContactCandidate],
                    mx: dict[str, MxResult], domain_mx: MxResult | None, result: EnrichResult,
                    deps: EnrichDeps, checked_at: datetime) -> None:
    with deps.open_tx() as tx:
        if domain_mx is not None and domain_mx.has_mx is not None:
            write_assertion(AssertionIn(
                subject_id=company_id, attribute="domain.mx",
                value={"has_mx": domain_mx.has_mx, "domain": domain},
                source_id=WEB_SOURCE_ID,
                source_ref={"domain": domain, "method": "dns_mx", "captured_at": checked_at.isoformat(),
                            "hosts": list(domain_mx.hosts[:10]), "enrich_v": ENRICH_V},
                observed_at=checked_at, checked_at=checked_at, confidence=1.0, region=country,
                producer=PRODUCER, producer_version=PRODUCER_VERSION,
            ), tx=tx)
        for c in candidates:
            mask = display_mask(c.kind, c.value, domain)
            deliv = _deliverability(c, mx)
            value: dict[str, Any] = {"value_hash": contact_value_hash(c.kind, c.value), "display_mask": mask}
            if deliv is not None:
                value["deliverability"] = deliv
            aid = write_assertion(AssertionIn(
                subject_id=company_id, attribute=f"contact.{c.kind}", value=value,
                source_id=WEB_SOURCE_ID,
                source_ref={"url": c.url, "captured_at": c.captured_at.isoformat(),
                            "raw_object_id": c.raw_object_id, "method": c.method, "enrich_v": ENRICH_V},
                observed_at=c.captured_at,
                checked_at=checked_at if c.kind == "role_email" else c.captured_at,
                confidence=c.confidence, personal_data_class="business_contact", region=country,
                producer=PRODUCER, producer_version=PRODUCER_VERSION,
            ), tx=tx)
            if aid is None:
                result.contacts.append(ContactResult(kind=c.kind, display_mask=mask, outcome="suppressed",
                                                     reason="suppressed_in_store"))
                continue
            put_contact_value(tx, aid, c.kind, c.value)
            result.contacts.append(ContactResult(kind=c.kind, display_mask=mask, outcome="written",
                                                 assertion_id=str(aid), deliverability=deliv))


# ---- the run -------------------------------------------------------------------------------------

def _homepages(domain: str) -> list[str]:
    return [f"https://{domain}/", f"https://www.{domain}/", f"http://{domain}/"]


def enrich_company(company_id: str, deps: EnrichDeps | None = None) -> EnrichResult:
    """Steps 1–6 for one company. Idempotent: re-running supersedes nothing that is unchanged
    (M09 refreshes ``checked_at`` of an identical active assertion)."""
    d = deps or EnrichDeps()
    with span("m22.enrich", {"company_id": str(company_id)}):
        # step 1 (short read transaction)
        with d.open_tx() as tx:
            try:
                cid = resolve_company_id(company_id, tx=tx)
            except CompanyNotFound:
                return EnrichResult(company_id=str(company_id), outcome="company_gone")
            company = get_company(cid, tx=tx)
            if company is None or company.status == "closed":
                return EnrichResult(company_id=cid, outcome="company_gone")
            domain = _usable_domain(company.primary_domain)
            source: Any = "primary_domain" if domain else None
            if domain is None:
                domain = guess_domain(_evidence_urls(get_assertions(cid, ["product_evidence"], tx=tx)))
                source = "evidence_guess" if domain else None
        country = company.country
        result = EnrichResult(company_id=cid, outcome="no_domain", domain=domain, domain_source=source)
        if domain is None:
            _log.info("no domain to enrich", extra={"company_id": cid})
            return result

        try:
            domain_blocked = d.suppressed("domain", domain)
        except KpError as e:
            if e.code != "VALIDATION":
                raise
            domain_blocked = True
        if domain_blocked:
            result.outcome = "domain_suppressed"
            return result

        dns = d.get_dns()
        if dns.domain_resolves(domain) is False:
            result.outcome = "domain_unresolvable"
            return result

        # step 2
        crawler = d.get_crawler()
        pages: list[ContactPage] = []
        for home in _homepages(domain):
            pages = crawler.crawl_contacts(home, domain)
            if pages:
                break
        result.pages = len(pages)

        # step 4 (company domain first; also used for emails on it)
        domain_mx = dns.mx_lookup(domain)
        result.has_mx = domain_mx.has_mx
        mx: dict[str, MxResult] = {domain: domain_mx}
        checked_at = d.utcnow()

        if not pages:
            result.outcome = "no_pages"
            _write_contacts(cid, country, domain, [], mx, domain_mx, result, d, checked_at)
            return result

        # step 3
        candidates, personal = extract_contacts(pages, domain, country)
        result.discarded_personal_emails = personal
        home = pages[0]
        candidates.insert(0, ContactCandidate(
            kind="website", value=f"https://{domain}/", url=home.url, captured_at=home.fetched_at,
            raw_object_id=home.raw_object_id, method="homepage", confidence=1.0))
        for c in candidates:
            if c.kind == "role_email":
                ed = _email_domain(c.value)
                if ed not in mx:
                    mx[ed] = dns.mx_lookup(ed)

        # step 6 (IF-10c before writing), then step 5
        to_write: list[ContactCandidate] = []
        for c in candidates:
            if _is_suppressed(d, c):
                result.contacts.append(ContactResult(kind=c.kind, display_mask=display_mask(c.kind, c.value, domain),
                                                     outcome="suppressed", reason="if_10c"))
            else:
                to_write.append(c)
        _write_contacts(cid, country, domain, to_write, mx, domain_mx, result, d, checked_at)
        result.outcome = "enriched"
    _log.info("enrichment finished", extra={"result": result.summary()})
    return result
