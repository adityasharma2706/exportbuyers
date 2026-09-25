"""M15 coverage rule, RULE_V=1 [tunable] (LLD M15).

- ``fresh`` = a company with any evidence assertion whose ``checked_at`` is within 180 days.
- **strong**:  ``'customs' in source_types`` AND fresh_company_count >= 50.
- **partial**: fresh_company_count >= 10 (any source).
- **limited**: otherwise.

Explanation keys: coverage.strong.customs, coverage.partial.web_only, coverage.partial.few,
coverage.limited. Params: ``{count, sources}``. The explanation is a message template rendered by
the UI (M04 <CoverageLabel/>); no generated text is stored.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Iterable, Literal

RULE_V = 1
FRESH_DAYS = 180                 # [tunable]
STRONG_MIN_FRESH = 50            # [tunable]
PARTIAL_MIN_FRESH = 10           # [tunable]
FRESH_WINDOW = timedelta(days=FRESH_DAYS)

COUNTRY_FALLBACK = "*"           # hs_heading of the country-level fallback row
CUSTOMS = "customs"
# Assertion attributes that tie a company to an HS heading (M09 vocabulary).
EVIDENCE_ATTRIBUTES: tuple[str, ...] = ("product_evidence", "activity_aggregate")

KEY_STRONG_CUSTOMS = "coverage.strong.customs"
KEY_PARTIAL_WEB_ONLY = "coverage.partial.web_only"
KEY_PARTIAL_FEW = "coverage.partial.few"
KEY_LIMITED = "coverage.limited"
COUNTRY_LEVEL_SUFFIX = ".country_level"

COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
HEADING_RE = re.compile(r"^[0-9]{4}$")

# Source-register types (M08) → the source names the UI message catalogue knows
# (coverageUi.source.*). Types without a mapping pass through unchanged.
_DISPLAY_SOURCE: dict[str, str] = {"website": "web"}
# Source types that never describe buyers and so are not listed as coverage sources.
_NON_BUYER_SOURCES = frozenset({"sanctions", "market_stats", "nomenclature"})

Label = Literal["strong", "partial", "limited"]


@dataclass(frozen=True)
class CellCounts:
    """What the evidence store holds for one country × heading (or the country fallback)."""

    country: str
    hs_heading: str
    source_types: tuple[str, ...]
    company_count: int
    fresh_company_count: int


@dataclass(frozen=True)
class CoverageCell:
    country: str
    hs_heading: str
    source_types: tuple[str, ...]
    company_count: int
    fresh_company_count: int
    label: Label
    explanation_key: str
    params: dict[str, Any] = field(default_factory=dict)
    rule_version: int = RULE_V
    computed_at: datetime | None = None


def validate_country(country: str) -> str:
    c = (country or "").strip().upper()
    if not COUNTRY_RE.match(c):
        raise ValueError(f"country must be ISO 3166-1 alpha-2, got {country!r}")
    return c


def validate_heading(heading: str) -> str:
    h = (heading or "").strip()
    if h == COUNTRY_FALLBACK:
        return h
    digits = h.replace(".", "")
    if len(digits) > 4 and digits.isdigit():
        digits = digits[:4]          # a 6/8-digit code maps to its heading
    if not HEADING_RE.match(digits):
        raise ValueError(f"hs heading must be 4 digits or '*', got {heading!r}")
    return digits


def normalise_source_types(types: Iterable[str | None]) -> tuple[str, ...]:
    """Distinct, sorted, buyer-relevant source types."""
    return tuple(sorted({t for t in types if t and t not in _NON_BUYER_SOURCES}))


def display_sources(types: Iterable[str]) -> list[str]:
    out: list[str] = []
    for t in types:
        d = _DISPLAY_SOURCE.get(t, t)
        if d not in out:
            out.append(d)
    return out


def classify(source_types: Iterable[str], fresh_company_count: int) -> tuple[Label, str]:
    """RULE_V=1 → (label, explanation_key)."""
    has_customs = CUSTOMS in set(source_types)
    if has_customs and fresh_company_count >= STRONG_MIN_FRESH:
        return "strong", KEY_STRONG_CUSTOMS
    if fresh_company_count >= PARTIAL_MIN_FRESH:
        # Without shipment records the ceiling is partial ("web only"); with them, there are just
        # too few recently checked buyers yet.
        return "partial", (KEY_PARTIAL_FEW if has_customs else KEY_PARTIAL_WEB_ONLY)
    return "limited", KEY_LIMITED


def build_cell(counts: CellCounts, computed_at: datetime | None = None) -> CoverageCell:
    if counts.fresh_company_count < 0 or counts.company_count < 0:
        raise ValueError("counts must be non-negative")
    if counts.fresh_company_count > counts.company_count:
        raise ValueError("fresh_company_count cannot exceed company_count")
    sources = normalise_source_types(counts.source_types)
    label, key = classify(sources, counts.fresh_company_count)
    return CoverageCell(
        country=counts.country,
        hs_heading=counts.hs_heading,
        source_types=sources,
        company_count=counts.company_count,
        fresh_company_count=counts.fresh_company_count,
        label=label,
        explanation_key=key,
        params={"count": counts.fresh_company_count, "sources": display_sources(sources)},
        rule_version=RULE_V,
        computed_at=computed_at,
    )


def fresh_cutoff(now: datetime) -> datetime:
    return now - FRESH_WINDOW
