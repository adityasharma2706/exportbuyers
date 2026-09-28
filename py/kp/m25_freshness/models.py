"""M25 data model: config, the ``m25.reverify`` / ``m25.nightly`` job payloads, EV-06 events and
``VerifyOutcome`` (LLD M25 IF-25a)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# ---- config [tunable] (LLD M25 "Config") ---------------------------------------------------

CONTACT_STALE_DAYS = 90        # [tunable] LLD M25: contacts are re-checked after this many days
RECRAWL_DAYS = 180             # [tunable] LLD M25: product evidence is re-crawled after this many days
REVERIFY_RPC_WAIT_MS = 12_000  # [tunable] LLD M25: /rpc/reverify's overall wait budget

NIGHTLY_CONTACT_LIMIT = 5000   # [tunable] LLD M25 nightly schedule: stale('contact.', 90d, limit=5000)
NIGHTLY_RECRAWL_LIMIT = 2000   # [tunable] cap on stale product_evidence assertions considered per night
NIGHTLY_CHUNK_SIZE = 200       # [tunable] assertions per m25.reverify job, so one job finishes well
                                # inside the M02 5-minute lease even under the per-check budget
NIGHTLY_CRON = "30 19 * * *"   # [tunable] ~01:00 IST daily (server clock is UTC)

CHECK_BUDGET_S = 8.0           # [tunable] per-assertion budget: MX + email vendor, or HTTP fetch
MAX_WORKERS = 24               # [tunable] shared thread pool size (see budget.py)

SOURCE_ID = "freshness.reverify"   # knowledge.source row this module writes under (migration 0025)
PRODUCER = "m25"
PRODUCER_VERSION = "reverify-v1"

QUEUE = "knowledge"
REVERIFY_JOB = "m25.reverify"          # nightly-only: see jobs.py for why reveal/report do not queue
NIGHTLY_JOB = "m25.nightly"
NIGHTLY_SCHEDULE = "m25.nightly-freshness"
RATE_CLASS = "m25.reverify"
MAX_ATTEMPTS = 4

# EV-06 (LLD M25 "Writes").
EV_CONTACT_VERIFIED = "contact.verified"
EV_CONTACT_INVALIDATED = "contact.invalidated"

Trigger = Literal["reveal", "report", "schedule"]
TRIGGERS: tuple[str, ...] = ("reveal", "report", "schedule")
DeliverabilityStatus = Literal["valid", "risky", "invalid", "unknown"]
STATUSES: tuple[str, ...] = ("valid", "risky", "invalid", "unknown")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def idempotency_key(trigger: str, trigger_ref: str, chunk_index: int = 0) -> str:
    """``reverify:<trigger>:<triggerRef>:<chunk>`` — used only for the nightly path's queued jobs
    (see jobs.py); chunk 0 is the whole batch when it fits in one job."""
    return f"reverify:{trigger}:{trigger_ref}:{chunk_index}"


# ---- IF-25a result ---------------------------------------------------------------------------

@dataclass(frozen=True)
class VerifyOutcome:
    """``{assertion_id, status, checked_at}`` (LLD M25 API)."""

    assertion_id: str
    status: DeliverabilityStatus
    checked_at: datetime

    def to_dict(self) -> dict[str, Any]:
        return {"assertionId": self.assertion_id, "status": self.status, "checkedAt": self.checked_at.isoformat()}


# ---- job payloads -----------------------------------------------------------------------------

class ReverifyPayload(BaseModel):
    """``m25.reverify {assertionIds, trigger, triggerRef}`` (nightly path only)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    assertion_ids: list[UUID] = Field(alias="assertionIds", min_length=1, max_length=NIGHTLY_CHUNK_SIZE)
    trigger: Trigger
    trigger_ref: str = Field(alias="triggerRef", min_length=1, max_length=200)

    def to_job_payload(self) -> dict[str, Any]:
        return {"assertionIds": [str(a) for a in self.assertion_ids], "trigger": self.trigger,
                "triggerRef": self.trigger_ref}


class NightlyPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    note: str | None = None


class ContactVerifiedEvent(BaseModel):
    """EV-06 ``contact.verified`` payload."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)
    assertion_id: UUID = Field(alias="assertionId")
    company_id: UUID = Field(alias="companyId")
    kind: str
    status: Literal["valid", "risky"]
    trigger: Trigger
    trigger_ref: str = Field(alias="triggerRef")


class ContactInvalidatedEvent(BaseModel):
    """EV-06 ``contact.invalidated`` payload."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)
    assertion_id: UUID = Field(alias="assertionId")
    company_id: UUID = Field(alias="companyId")
    kind: str
    trigger: Trigger
    trigger_ref: str = Field(alias="triggerRef")
