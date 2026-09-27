"""M22 data model: the ``m22.enrich`` job payload, extracted contact candidates and run results."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---- constants ---------------------------------------------------------------------------------

ENRICH_JOB = "m22.enrich"
EV01_HANDLER = "m22.enrich_on_change"
QUEUE = "knowledge"
ENRICH_RATE_CLASS = "m22.enrich"

ENRICH_V = 1
PRODUCER = "m22"
PRODUCER_VERSION = f"enrich-v{ENRICH_V}"

WEB_SOURCE_ID = "web.crawl"            # contacts come from the company's own website
MAX_ATTEMPTS = 4

# EV-01 attribute classes that trigger enrichment (LLD M22 "Job").
TRIGGER_CLASSES: frozenset[str] = frozenset({"product_evidence", "domain"})

# LLD M22 step 3: role mailboxes only. Anything else (firstname.lastname@, j.smith@, …) is discarded.
ROLE_EMAIL_RE = re.compile(
    r"^(info|sales|export|import|purchasing|procurement|buying|contact|office|enquiries)@", re.IGNORECASE
)

MAX_PHONES = 3
MAX_EMAILS = 5
MAX_FORMS = 2
MAX_WHATSAPP = 2
MAX_ADDRESS_CHARS = 300

ContactKind = Literal["website", "phone", "role_email", "form_url", "address", "whatsapp"]
Reason = Literal["entity_changed", "reverify", "manual"]


def idempotency_key(company_id: str, day: datetime) -> str:
    """``enrich:<companyId>:<yyyy-mm-dd>`` — the job is idempotent per company per day."""
    return f"enrich:{company_id}:{day.strftime('%Y-%m-%d')}"


# ---- job payload -------------------------------------------------------------------------------

class EnrichPayload(BaseModel):
    """``m22.enrich {companyId, reason?}``."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    company_id: UUID = Field(alias="companyId")
    reason: Reason = "entity_changed"

    def to_job_payload(self) -> dict[str, Any]:
        return {"companyId": str(self.company_id), "reason": self.reason}

    @field_validator("reason", mode="before")
    @classmethod
    def _reason(cls, v: Any) -> Any:
        return "entity_changed" if v is None else v


# ---- pipeline values ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ContactPage:
    """One crawled page of the company site, with its raw HTML (needed for forms and addresses)."""

    url: str
    html: str
    fetched_at: datetime
    raw_object_id: str | None
    sha256: str


@dataclass(frozen=True)
class ContactCandidate:
    """A contact value found on a page, before the MX, suppression and write steps."""

    kind: ContactKind
    value: str                 # the canonical value stored in contact_value
    url: str                   # page it was found on
    captured_at: datetime
    raw_object_id: str | None
    method: str                # how it was found: mailto, text, tel_link, jsonld, address_tag, form, wa_link, homepage
    confidence: float

    def dedupe_key(self) -> tuple[str, str]:
        return (self.kind, self.value.casefold())


@dataclass(frozen=True)
class MxResult:
    domain: str
    has_mx: bool | None        # None = the lookup failed (timeout, no nameservers)
    hosts: tuple[str, ...] = ()
    error: str | None = None


ContactOutcome = Literal["written", "suppressed", "discarded"]


@dataclass
class ContactResult:
    kind: str
    display_mask: str
    outcome: ContactOutcome
    assertion_id: str | None = None
    deliverability: str | None = None
    reason: str | None = None


Outcome = Literal["enriched", "no_domain", "domain_suppressed", "domain_unresolvable", "no_pages", "company_gone"]


@dataclass
class EnrichResult:
    company_id: str
    outcome: Outcome
    domain: str | None = None
    domain_source: Literal["primary_domain", "evidence_guess"] | None = None
    has_mx: bool | None = None
    pages: int = 0
    contacts: list[ContactResult] = field(default_factory=list)
    discarded_personal_emails: int = 0

    @property
    def contact_types(self) -> list[str]:
        """REQ-016: which contact types now exist for this company (invalid ones do not count)."""
        return sorted({c.kind for c in self.contacts
                       if c.outcome == "written" and c.deliverability != "invalid"})

    def summary(self) -> dict[str, Any]:
        counts: dict[str, int] = {}
        for c in self.contacts:
            counts[c.outcome] = counts.get(c.outcome, 0) + 1
        return {
            "companyId": self.company_id, "outcome": self.outcome, "domain": self.domain,
            "domainSource": self.domain_source, "hasMx": self.has_mx, "pages": self.pages,
            "contacts": counts, "contactTypes": self.contact_types,
            "discardedPersonalEmails": self.discarded_personal_emails, "enrichV": ENRICH_V,
        }
