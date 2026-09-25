"""M17 data types."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ListKey = Literal["ofac_sdn", "ofac_cons", "un", "eu", "uk_ofsi"]
LIST_KEYS: tuple[ListKey, ...] = ("ofac_sdn", "ofac_cons", "un", "eu", "uk_ofsi")
EntityType = Literal["individual", "entity", "vessel", "aircraft", "unknown"]
ENTITY_TYPES: tuple[str, ...] = ("individual", "entity", "vessel", "aircraft", "unknown")
Result = Literal["clear", "possible", "hit"]
Decision = Literal["confirmed", "cleared"]

# Licence-register source (M08, config/sources.yaml) of each list.
LIST_SOURCE: dict[str, str] = {
    "ofac_sdn": "sanctions.us.ofac",
    "ofac_cons": "sanctions.us.ofac",
    "un": "sanctions.un.sc",
    "eu": "sanctions.eu.fsf",
    "uk_ofsi": "sanctions.gb.ofsi",
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class ParsedEntry:
    """One designation as read from a list file (before normalisation and diffing)."""

    list: str
    list_uid: str
    names: tuple[str, ...]
    countries: tuple[str, ...] = ()
    entity_type: str = "unknown"

    def content_hash(self) -> str:
        doc = {"names": sorted(set(self.names)), "countries": sorted(set(self.countries)), "type": self.entity_type}
        return hashlib.sha256(json.dumps(doc, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class SanctionsEntry:
    id: str
    list: str
    list_uid: str
    names: tuple[str, ...]
    names_norm: tuple[str, ...]
    countries: tuple[str, ...]
    entity_type: str
    list_version: str
    active: bool = True
    updated_at: datetime | None = None


@dataclass(frozen=True)
class Match:
    entry_id: str
    list: str
    list_uid: str
    name: str
    score: float

    def as_dict(self) -> dict[str, Any]:
        return {"entry_id": self.entry_id, "list": self.list, "list_uid": self.list_uid, "name": self.name,
                "score": round(self.score, 2)}


@dataclass
class ScreenRow:
    subject_key: str
    result: str
    raw_result: str
    matched_entry_ids: list[str]
    best_score: float
    list_versions: dict[str, str]
    input_hash: str
    screened_at: datetime
    decision: str | None = None
    decided_at: datetime | None = None
    decision_entry_ids: list[str] | None = None


@dataclass
class ListLoad:
    list: str
    list_version: str
    loaded_at: datetime
    entry_count: int
    added: int = 0
    changed: int = 0
    removed: int = 0


@dataclass
class DiffStats:
    list: str
    list_version: str
    entry_count: int = 0
    added: int = 0
    changed: int = 0
    removed: int = 0
    changed_entry_ids: list[str] = field(default_factory=list)

    @property
    def any_change(self) -> bool:
        return bool(self.added or self.changed or self.removed)


class ScreenResult(BaseModel):
    """Outcome of one screen. ``result`` has any stored operator decision applied; ``raw_result``
    is what the matcher alone said."""

    model_config = ConfigDict(extra="forbid")

    subject_key: str
    result: Result
    raw_result: Result
    best_score: float = Field(ge=0.0)
    matched_entry_ids: list[str] = Field(default_factory=list)
    matches: list[dict[str, Any]] = Field(default_factory=list)
    list_versions: dict[str, str] = Field(default_factory=dict)
    screened_at: datetime
    decision: Decision | None = None
    cached: bool = False

    @property
    def block(self) -> bool:
        return self.result in ("hit", "possible")
