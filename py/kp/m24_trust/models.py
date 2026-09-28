"""M24 Trust engine — data model.

Six pluggable checks (LLD M24 "Checks" table): ``registered_entity``, ``website_consistent``,
``domain_age``, ``corporate_email``, ``recent_trade`` and ``sanctions``. Each returns a
``CheckOutcome`` (pass / fail / unknown, a ``checked_at``, an optional supporting assertion id and
an ``explanation_key``). A deterministic, versioned rollup (``rollup.py``, ``RULE_V``) turns the
six outcomes into a ``RollupResult`` (high / medium / low / unknown).

Wording is never inlined here: every outcome and the rollup itself carry only an
``explanation_key`` string (e.g. ``trust.check.registered_entity.pass``). The actual copy is
rendered elsewhere (LLD: "wording lives only in M37 keys") from that key — this module never
produces the words "verified", "genuine" or "guaranteed" (checked by
``test_m24_trust.py::test_no_forbidden_words``).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

TrustOutcome = Literal["pass", "fail", "unknown"]
TrustLevel = Literal["high", "medium", "low", "unknown"]

CHECK_IDS: tuple[str, ...] = (
    "registered_entity", "website_consistent", "domain_age", "corporate_email", "recent_trade", "sanctions",
)
TRUST_OUTCOMES: tuple[str, ...] = ("pass", "fail", "unknown")
TRUST_LEVELS: tuple[str, ...] = ("high", "medium", "low", "unknown")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class TrustSubject:
    """The thing being checked.

    ``company_id`` set (and ``is_adhoc`` False) means a canonical M09 company: checks may read
    and write M09 assertions in the caller's transaction (the EV-01 / job path). Otherwise this is
    free text — M32's ad hoc use of IF-24b — and nothing is ever written (LLD: "DS-08 with no
    writes").
    """

    company_id: str | None = None
    name: str | None = None
    country: str | None = None      # ISO 3166-1 alpha-2, upper-case
    city: str | None = None
    address: str | None = None
    domain: str | None = None       # a bare domain, already known
    website: str | None = None      # a URL or domain; normalised by each check that needs it
    email: str | None = None
    is_adhoc: bool = False

    def label(self) -> str:
        return self.company_id or self.name or self.email or self.website or self.domain or "<unknown subject>"


@dataclass(frozen=True)
class CheckOutcome:
    """One check's result (LLD M24 "Checks" table): ``{outcome, checked_at, assertion_id, explanation_key}``."""

    check_id: str
    outcome: TrustOutcome
    checked_at: datetime
    explanation_key: str
    assertion_id: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.check_id,
            "outcome": self.outcome,
            "checkedAt": self.checked_at.isoformat(),
            "explanationKey": self.explanation_key,
            "assertionId": self.assertion_id,
        }


@dataclass(frozen=True)
class RollupResult:
    """``trust.rollup`` (LLD M24 "Rollup", ``RULE_V=1``): ``{level, rule_version, copy_version}``."""

    level: TrustLevel
    rule_version: int
    copy_version: str
    checks: dict[str, CheckOutcome]
    computed_at: datetime
    assertion_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "level": self.level,
            "ruleVersion": self.rule_version,
            "copyVersion": self.copy_version,
            "computedAt": self.computed_at.isoformat(),
            "checks": [self.checks[c].to_dict() for c in CHECK_IDS if c in self.checks],
        }
