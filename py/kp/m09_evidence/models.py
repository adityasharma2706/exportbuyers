"""M09 data model: assertions (DS-04), canonical companies, errors."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from kp.m01_platform import KpError

SubjectType = Literal["company", "person"]
Polarity = Literal["positive", "negative"]
PersonalDataClass = Literal["none", "business_contact", "named_person"]
CompanyStatus = Literal["active", "merged", "closed"]
AnchorKind = Literal["registry", "lei", "vat", "domain"]
ANCHOR_KINDS: tuple[str, ...] = ("registry", "lei", "vat", "domain")

# Least to most restrictive. A caller may move an assertion to the right, never to the left.
PDC_ORDER: dict[str, int] = {"none": 0, "business_contact": 1, "named_person": 2}

AssertionId = str
CompanyId = str


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(v: datetime | None) -> datetime | None:
    if v is None:
        return None
    return v if v.tzinfo is not None else v.replace(tzinfo=timezone.utc)


# ---- errors ---------------------------------------------------------------------------------

class MissingPageReference(KpError):
    """An LLM-assisted assertion without ``source_ref.url`` and ``source_ref.captured_at`` (DS-04)."""

    def __init__(self, attribute: str) -> None:
        super().__init__("VALIDATION",
                         f'LLM-assisted assertion "{attribute}" must reference the captured page (url and captured_at)',
                         {"attribute": attribute, "reason": "missing_page_reference"})


class PersonalDataDisabled(KpError):
    """``named_person`` data is modelled but disabled (REQ-035 is not built)."""

    def __init__(self, what: str = "named_person") -> None:
        super().__init__("POLICY_DENIED", f"Personal data of class {what} is disabled and cannot be stored",
                         {"reason": "named_person_disabled"})


class CompanyNotFound(KpError):
    def __init__(self, company_id: str) -> None:
        super().__init__("NOT_FOUND", f"Company {company_id} does not exist", {"company_id": company_id})


class MergeCycle(KpError):
    def __init__(self, company_id: str) -> None:
        super().__init__("INTERNAL", f"merged_into chain for {company_id} has a cycle or exceeds 10 hops",
                         {"company_id": company_id})


class AnchorConflict(KpError):
    def __init__(self, kind: str, value_norm: str, existing: str) -> None:
        super().__init__("CONFLICT", f"Anchor {kind}:{value_norm} already belongs to company {existing}",
                         {"kind": kind, "value_norm": value_norm, "company_id": existing})
        self.existing = existing


# ---- assertions -----------------------------------------------------------------------------

class AssertionIn(BaseModel):
    """IF-09a input. Licence flags are optional: they are inherited from the source and a caller
    may only make them more restrictive."""

    model_config = ConfigDict(extra="forbid")

    subject_type: SubjectType = "company"
    subject_id: UUID
    attribute: str
    value: dict[str, Any]
    polarity: Polarity = "positive"
    source_id: str
    source_ref: dict[str, Any]
    observed_at: datetime | None = None
    checked_at: datetime | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    can_display: bool | None = None
    can_export: bool | None = None
    personal_data_class: PersonalDataClass | None = None
    region: str | None = None
    producer: str = Field(min_length=1, max_length=100)
    producer_version: str = Field(min_length=1, max_length=100)
    llm_assisted: bool = False

    @field_validator("region")
    @classmethod
    def _region(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip().upper()
        if len(v) != 2 or not v.isalpha():
            raise ValueError("region must be an ISO 3166-1 alpha-2 code")
        return v

    @field_validator("observed_at", "checked_at")
    @classmethod
    def _tz(cls, v: datetime | None) -> datetime | None:
        return _aware(v)


class Assertion(BaseModel):
    """A stored assertion (``knowledge.assertion`` row)."""

    model_config = ConfigDict(extra="ignore")

    id: str
    subject_type: SubjectType
    subject_id: str
    attribute: str
    value: dict[str, Any]
    polarity: Polarity
    source_id: str
    source_type: str
    source_ref: dict[str, Any]
    observed_at: datetime
    checked_at: datetime
    confidence: float
    can_display: bool
    can_export: bool
    personal_data_class: PersonalDataClass
    region: str | None = None
    producer: str
    producer_version: str
    llm_assisted: bool = False
    superseded_by: str | None = None
    hs_heading: str | None = None
    created_at: datetime

    @field_validator("id", "subject_id", "superseded_by", mode="before")
    @classmethod
    def _uuid_str(cls, v: Any) -> Any:
        return str(v) if isinstance(v, UUID) else v

    @field_validator("observed_at", "checked_at", "created_at")
    @classmethod
    def _tz(cls, v: datetime) -> datetime:
        return _aware(v)  # type: ignore[return-value]

    @property
    def is_active(self) -> bool:
        return self.superseded_by is None


class Company(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    status: CompanyStatus
    merged_into: str | None = None
    display_name: str
    country: str
    city: str | None = None
    primary_domain: str | None = None
    created_at: datetime
    updated_at: datetime

    @field_validator("id", "merged_into", mode="before")
    @classmethod
    def _uuid_str(cls, v: Any) -> Any:
        return str(v) if isinstance(v, UUID) else v


class ContactValue(BaseModel):
    assertion_id: str
    company_id: str
    kind: str
    value: str
    value_hash: str
