"""M18 IF-18a models: Candidate, Resolution, and the internal match-key / review shapes."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

Method = Literal["anchor", "fuzzy", "new", "suppressed", "review"]

# LLD M18 step 4 thresholds [tunable].
NAME_PREFILTER = 0.5
MATCH_THRESHOLD = 0.92
REVIEW_THRESHOLD = 0.80
W_NAME, W_CITY, W_ADDRESS = 0.6, 0.2, 0.2

_CC = re.compile(r"^[A-Z]{2}$")


class Candidate(BaseModel):
    """A company as seen by one source record (IF-18a)."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=500)
    country: str
    city: str | None = Field(default=None, max_length=200)
    address: str | None = Field(default=None, max_length=2000)
    domain: str | None = Field(default=None, max_length=2048)
    registry_ids: list[str] = Field(default_factory=list, max_length=20)
    lei: str | None = Field(default=None, max_length=40)
    vat: str | None = Field(default=None, max_length=40)
    source_id: str = Field(min_length=1, max_length=200)

    @field_validator("country")
    @classmethod
    def _country(cls, v: str) -> str:
        cc = (v or "").strip().upper()
        if not _CC.match(cc):
            raise ValueError("country must be an ISO 3166-1 alpha-2 code")
        return cc

    @field_validator("city", "address", "domain", "lei", "vat")
    @classmethod
    def _blank_to_none(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v if v.strip() else None

    @field_validator("registry_ids")
    @classmethod
    def _registry_ids(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for r in v:
            if isinstance(r, str) and r.strip() and r.strip() not in out:
                out.append(r.strip())
        return out


class Resolution(BaseModel):
    """IF-18a result. ``method='suppressed'`` → ``company_id`` is None and the caller must drop the record."""

    company_id: UUID | None
    created: bool
    confidence: float = Field(ge=0.0, le=1.0)
    method: Method


@dataclass(frozen=True)
class MatchKey:
    """What fuzzy matching needs per canonical company (knowledge.company_match_key)."""

    company_id: str
    country: str
    name_norm: str
    city_norm: str | None = None
    address_tokens: frozenset[str] = field(default_factory=frozenset)
    display_name: str = ""


@dataclass(frozen=True)
class ScoredMatch:
    key: MatchKey
    score: float
    name_sim: float
    city_match: float
    address_overlap: float


@dataclass(frozen=True)
class MergeReview:
    """Payload of ``entity.merge_review``: ``a`` survives, ``b`` is the suspected duplicate."""

    a: str
    b: str
    score: float
    reason: Literal["fuzzy", "anchor_conflict"]
    country: str
    a_name: str
    b_name: str
    source_id: str
    name_sim: float | None = None
    city_match: float | None = None
    address_overlap: float | None = None
    conflicting_anchors: tuple[str, ...] = ()

    def to_payload(self) -> dict[str, object]:
        signals = None
        if self.name_sim is not None:
            signals = {"nameSim": round(self.name_sim, 4), "cityMatch": round(self.city_match or 0.0, 4),
                       "addressOverlap": round(self.address_overlap or 0.0, 4)}
        return {
            "a": self.a,
            "b": self.b,
            "score": round(min(max(self.score, 0.0), 1.0), 4),
            "reason": self.reason,
            "country": self.country,
            "aName": self.a_name[:500],
            "bName": self.b_name[:500],
            "sourceId": self.source_id,
            "signals": signals,
            "conflictingAnchors": list(self.conflicting_anchors),
        }
