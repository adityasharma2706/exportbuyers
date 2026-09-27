"""M23 value types (IF-23a).

``Unavailable`` is a *value*, never an exception: callers (M24 trust checks, M18 anchors) map it to
``unknown``. Every result type round-trips through ``to_dict`` / ``result_from_dict`` so it can be
cached in Redis as JSON.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Mapping, Union

RegistryStatus = Literal["active", "inactive", "dissolved", "unknown"]
UnavailableReason = Literal[
    "rate_limited",        # our own per-vendor rate class had no token within the wait budget
    "upstream_error",      # HTTP / DNS / socket failure, 5xx, unparseable body
    "not_configured",      # API key missing, or an optional vendor is switched off
    "source_inactive",     # licence register says the source is not active (or not registered)
    "region_not_allowed",  # licence register does not allow this source for the subject's country
    "robots",              # robots.txt or prohibited-host refusal from the M08 HTTP helper
    "invalid_input",       # the name / VAT number / domain could not be used for a query
    "no_registry",         # no connector covers this country / VAT prefix / TLD
    "budget_exceeded",     # the vendor's M01 budget flag is set
]

REGISTRY_STATUSES: tuple[str, ...] = ("active", "inactive", "dissolved", "unknown")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()


@dataclass(frozen=True)
class Unavailable:
    """The lookup could not be answered. ``source`` names the vendor (or 'registry' for a combined
    lookup in which every consulted vendor failed)."""

    source: str
    reason: UnavailableReason
    detail: str | None = None
    kind: Literal["unavailable"] = "unavailable"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RegistryCandidate:
    """One company record returned by a registry search, before best-match selection."""

    source_id: str
    legal_name: str
    status: RegistryStatus
    country: str | None
    registry_id: str | None = None      # M09 anchor form 'CC:reg:ident', e.g. 'GB:ch:01234567'
    lei: str | None = None
    company_number: str | None = None
    address: str | None = None
    incorporated_on: str | None = None  # ISO date
    dissolved_on: str | None = None     # ISO date
    url: str | None = None
    other_names: tuple[str, ...] = ()


@dataclass(frozen=True)
class RegistryMatch:
    """Result of ``registry_lookup``.

    ``matched`` is False when every consulted registry answered and none had a candidate; the
    remaining fields then describe the query only. ``name_similarity`` is 0..1 on normalised names
    (legal-form words removed); M24 requires >= 0.9 for a pass.
    """

    matched: bool
    query_name: str
    query_country: str
    checked_at: str
    sources_checked: tuple[str, ...]
    source_id: str | None = None
    legal_name: str | None = None
    status: RegistryStatus = "unknown"
    name_similarity: float = 0.0
    country: str | None = None
    registry_id: str | None = None
    lei: str | None = None
    company_number: str | None = None
    address: str | None = None
    incorporated_on: str | None = None
    dissolved_on: str | None = None
    url: str | None = None
    kind: Literal["registry_match"] = "registry_match"

    @property
    def anchors(self) -> dict[str, str]:
        """Entity anchors for M18 / M09 ``add_anchor`` (kinds 'lei' and 'registry')."""
        out: dict[str, str] = {}
        if not self.matched:
            return out
        if self.lei:
            out["lei"] = self.lei
        if self.registry_id:
            out["registry"] = self.registry_id
        return out

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["sources_checked"] = list(self.sources_checked)
        return d


@dataclass(frozen=True)
class VatResult:
    """Result of ``vat_check``. ``valid`` is VIES' authoritative answer for the number."""

    vat: str                      # normalised, e.g. 'DE123456789' (Greece as 'EL…')
    country_code: str             # VIES member-state code (EL for Greece, XI for Northern Ireland)
    number: str
    valid: bool
    checked_at: str
    source_id: str
    name: str | None = None
    address: str | None = None
    request_date: str | None = None
    kind: Literal["vat_result"] = "vat_result"

    @property
    def iso_country(self) -> str:
        return {"EL": "GR", "XI": "GB"}.get(self.country_code, self.country_code)

    @property
    def anchors(self) -> dict[str, str]:
        return {"vat": self.vat} if self.valid else {}

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class DomainSignals:
    """Result of ``domain_signals``.

    ``age_days`` is None when neither RDAP nor WHOIS gave a registration date. ``has_mx`` is None
    when the DNS lookup itself failed (resolver outage), so that an outage is never read as
    "no mail server". ``rdap_available`` is True when an RDAP server answered for the domain.
    """

    domain: str
    age_days: int | None
    has_mx: bool | None
    is_freemail: bool
    rdap_available: bool
    checked_at: str
    registered_on: str | None = None     # ISO date of registration
    age_source: Literal["rdap", "whois"] | None = None
    registrable_domain: str | None = None  # the name the registration date belongs to
    mx_hosts: tuple[str, ...] = field(default_factory=tuple)
    kind: Literal["domain_signals"] = "domain_signals"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["mx_hosts"] = list(self.mx_hosts)
        return d


Result = Union[RegistryMatch, VatResult, DomainSignals, Unavailable]


def result_from_dict(d: Mapping[str, Any]) -> Result:
    """Inverse of ``to_dict`` for any M23 result (used by the cache)."""
    data = dict(d)
    kind = data.get("kind")
    if kind == "unavailable":
        return Unavailable(**data)
    if kind == "registry_match":
        data["sources_checked"] = tuple(data.get("sources_checked") or ())
        return RegistryMatch(**data)
    if kind == "vat_result":
        return VatResult(**data)
    if kind == "domain_signals":
        data["mx_hosts"] = tuple(data.get("mx_hosts") or ())
        return DomainSignals(**data)
    raise ValueError(f"unknown M23 result kind {kind!r}")


def is_unavailable(r: object) -> bool:
    return isinstance(r, Unavailable)
