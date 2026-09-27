"""M22 Enrichment waterfall: discovery-time contacts — Python public API.

REQ-032 (company and role-level contacts from the company's own website), REQ-033 (every contact
carries its source page and last-checked date), REQ-016 (which contact types exist for search rows:
M09's projection derives ``contact_types`` from the ``contact.<kind>`` assertions written here).

- Job ``m22.enrich {companyId, reason?}``, idempotent per company per day
  (``enrich:<companyId>:<yyyy-mm-dd>``); triggered by EV-01 when the attribute classes include
  ``product_evidence`` or ``domain``, and by M25 via ``request_enrichment``.
- Domain → robots-aware crawl of contact/about pages (M20's ``web.crawl`` connector, M08 landing) →
  deterministic extraction (role emails only; personal-looking mailboxes discarded) → own MX check
  (``domain.mx``) → IF-10c → ``contact.<kind>`` assertions + ``contact_value`` rows (M09).
- Google Places is not used (architecture §3.3).

Other modules import only from here.
"""
from .crawl import CONTACT_PATH_PATTERNS, MAX_CONTACT_PAGES, ContactCrawler, contact_links
from .dns_check import (
    DnsChecker,
    DnsPythonChecker,
    default_dns_checker,
    set_dns_checker_for_testing,
)
from .extract import classify_email, extract_contacts, extract_page, whatsapp_link
from .jobs import (
    handle_enrich,
    on_entity_changed,
    register_enrichment_jobs,
    request_enrichment,
    reset_registration_for_testing,
    set_deps_for_testing,
    should_enrich,
)
from .models import (
    ENRICH_JOB,
    ENRICH_RATE_CLASS,
    ENRICH_V,
    EV01_HANDLER,
    PRODUCER,
    PRODUCER_VERSION,
    ROLE_EMAIL_RE,
    TRIGGER_CLASSES,
    WEB_SOURCE_ID,
    ContactCandidate,
    ContactPage,
    ContactResult,
    EnrichPayload,
    EnrichResult,
    MxResult,
    idempotency_key,
)
from .pipeline import (
    EnrichDeps,
    display_mask,
    enrich_company,
    guess_domain,
    mask_domain,
    mask_email,
    mask_phone,
)

__all__ = [
    "CONTACT_PATH_PATTERNS",
    "ENRICH_JOB",
    "ENRICH_RATE_CLASS",
    "ENRICH_V",
    "EV01_HANDLER",
    "MAX_CONTACT_PAGES",
    "PRODUCER",
    "PRODUCER_VERSION",
    "ROLE_EMAIL_RE",
    "TRIGGER_CLASSES",
    "WEB_SOURCE_ID",
    "ContactCandidate",
    "ContactCrawler",
    "ContactPage",
    "ContactResult",
    "DnsChecker",
    "DnsPythonChecker",
    "EnrichDeps",
    "EnrichPayload",
    "EnrichResult",
    "MxResult",
    "classify_email",
    "contact_links",
    "default_dns_checker",
    "display_mask",
    "enrich_company",
    "extract_contacts",
    "extract_page",
    "guess_domain",
    "handle_enrich",
    "idempotency_key",
    "mask_domain",
    "mask_email",
    "mask_phone",
    "on_entity_changed",
    "register_enrichment_jobs",
    "request_enrichment",
    "reset_registration_for_testing",
    "set_deps_for_testing",
    "set_dns_checker_for_testing",
    "should_enrich",
    "whatsapp_link",
]
