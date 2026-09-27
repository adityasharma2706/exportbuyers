"""M19 data model: IF-19a input (``EvidenceText``) and output (``Classification``)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

BuyerType = Literal["importer", "distributor", "wholesaler", "retailer", "manufacturer", "unknown"]
BUYER_TYPES: tuple[str, ...] = ("importer", "distributor", "wholesaler", "retailer", "manufacturer", "unknown")
KNOWN_BUYER_TYPES: tuple[str, ...] = tuple(t for t in BUYER_TYPES if t != "unknown")

LogisticsMethod = Literal["curated", "keyword", "llm", "none"]

# Source register entry used for every classifier write (LLD M19 step 4).
CLASSIFIER_SOURCE_ID = "operator.classifier"
PRODUCER = "m19"
PRODUCER_VERSION = "1"

# LLD M19 step 1 / step 2 confidences.
CURATED_CONFIDENCE = 1.0
KEYWORD_CONFIDENCE = 0.85

MAX_SNIPPET_CHARS = 500     # per snippet sent to the LLM [tunable]
MAX_SNIPPETS = 20           # snippets sent to the LLM per company [tunable]


class EvidenceText(BaseModel):
    """One piece of evidence the classifier may read: normally a ``product_evidence`` snippet.

    ``assertion_id`` is the M09 assertion the text came from; the LLM must cite these ids.
    ``url`` / ``captured_at`` are the captured page the snippet was taken from; they are needed
    for LLM-assisted writes (M09 DS-04 page-reference rule).
    """

    model_config = ConfigDict(extra="ignore")

    assertion_id: UUID
    text: str = Field(min_length=1, max_length=20000)
    url: str | None = None
    captured_at: datetime | str | None = None
    hs_heading: str | None = None

    @field_validator("text")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("text must not be blank")
        return v

    @property
    def has_page_reference(self) -> bool:
        return bool(self.url and self.url.strip()) and self.captured_at is not None \
            and str(self.captured_at).strip() != ""

    def captured_at_iso(self) -> str | None:
        if self.captured_at is None:
            return None
        if isinstance(self.captured_at, datetime):
            return self.captured_at.isoformat()
        return str(self.captured_at)


class Classification(BaseModel):
    """IF-19a output."""

    is_logistics: bool
    logistics_confidence: float = Field(ge=0.0, le=1.0)
    buyer_type: BuyerType
    type_confidence: float = Field(ge=0.0, le=1.0)
    evidence_assertion_ids: list[UUID] = Field(default_factory=list)
    # Additions beyond IF-19a (diagnostics; not part of the contract other modules rely on).
    logistics_method: LogisticsMethod = "none"
    matched_rule: str | None = None
    written_assertion_ids: list[str] = Field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {"is_logistics": self.is_logistics, "logistics_confidence": self.logistics_confidence,
                "buyer_type": self.buyer_type, "type_confidence": self.type_confidence,
                "method": self.logistics_method, "evidence": len(self.evidence_assertion_ids)}
