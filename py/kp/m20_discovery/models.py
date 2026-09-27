"""M20 data model: the IF-20a job payload, search results, crawled pages, extraction output and
run results."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---- constants ---------------------------------------------------------------------------------

DISCOVER_JOB = "m20.discover"
PREWARM_JOB = "m20.prewarm"
PREWARM_SCHEDULE = "m20.prewarm-weekly"
QUEUE = "knowledge"

# EV-05 DiscoveryCompleted {country, hsHeading, newCompanies, runId, degraded?}; M15 subscribes to it.
EV_DISCOVERY_COMPLETED = "discovery.completed"

# Model version every run's output is tagged with (HLD OQ9 precision bar).
DISCOVERY_V = 1
PRODUCER = "m20"
PRODUCER_VERSION = f"discovery-v{DISCOVERY_V}"

WEB_SOURCE_ID = "web.crawl"          # knowledge.source row for company websites (config/sources.yaml)
SEARCH_RATE_CLASS = "search_api"     # M02 rate class for search-API-bound jobs
CRAWL_RATE_CLASS = "web_crawl"
SEARCH_VENDOR = "search_api"         # vendor name for cost metrics and the budget flag

DEGRADE_AFTER_ATTEMPTS = 3           # search-API failures before completing degraded (LLD M20 Errors)
MAX_ATTEMPTS = 5                     # safety margin for non-search failures
SNIPPET_MAX_CHARS = 300

INTERNAL_PAGE_RE = re.compile(r"products|about|contact|import|brands", re.IGNORECASE)

_CC_RE = re.compile(r"^[A-Z]{2}$")
_HEADING_RE = re.compile(r"^\d{4}$")

Reason = Literal["prewarm", "on_demand"]


def idempotency_key(heading: str, country: str, day: datetime) -> str:
    """``disc:<heading>:<country>:<yyyy-mm-dd>`` — dedupes in-flight requests for the same day."""
    return f"disc:{heading}:{country.upper()}:{day.strftime('%Y-%m-%d')}"


# ---- IF-20a payload ----------------------------------------------------------------------------

class DiscoverPayload(BaseModel):
    """``m20.discover {hsHeading, country, reason, requestedBy?}``."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    hs_heading: str = Field(alias="hsHeading")
    country: str
    reason: Reason
    requested_by: UUID | None = Field(default=None, alias="requestedBy")
    # Optional: restrict the run to one domain (M25's product_evidence re-crawl).
    domain: str | None = Field(default=None, max_length=253)

    @field_validator("hs_heading")
    @classmethod
    def _h(cls, v: str) -> str:
        v = str(v).strip()
        if not _HEADING_RE.match(v):
            raise ValueError("hsHeading must be a 4-digit HS heading")
        return v

    @field_validator("country")
    @classmethod
    def _c(cls, v: str) -> str:
        v = str(v).strip().upper()
        if not _CC_RE.match(v):
            raise ValueError("country must be an ISO 3166-1 alpha-2 code")
        return v

    def to_job_payload(self) -> dict[str, Any]:
        out: dict[str, Any] = {"hsHeading": self.hs_heading, "country": self.country, "reason": self.reason}
        if self.requested_by is not None:
            out["requestedBy"] = str(self.requested_by)
        if self.domain is not None:
            out["domain"] = self.domain
        return out


class PrewarmPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    note: str | None = None


# ---- pipeline values ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SearchQuery:
    text: str
    language: str
    country: str


@dataclass(frozen=True)
class SearchResult:
    url: str
    title: str = ""
    description: str = ""
    rank: int = 0
    query: str = ""


@dataclass(frozen=True)
class CandidateSite:
    """One registrable domain found by search, with the homepage URL to start the crawl from."""

    domain: str
    homepage: str
    first_result: SearchResult


@dataclass(frozen=True)
class CrawledPage:
    url: str
    text: str
    title: str
    site_name: str | None
    links: tuple[str, ...]
    fetched_at: datetime
    raw_object_id: str | None
    sha256: str


@dataclass(frozen=True)
class VerifiedSnippet:
    text: str
    url: str
    captured_at: datetime
    raw_object_id: str | None


class ExtractedSnippet(BaseModel):
    model_config = ConfigDict(extra="ignore")
    text: str
    url: str


class Extraction(BaseModel):
    """Raw LLM output (step 4); nothing in it is a fact until verified against the page text."""

    model_config = ConfigDict(extra="ignore")
    is_buyer_of_product: bool
    confidence: float = Field(ge=0.0, le=1.0)
    snippets: list[ExtractedSnippet] = Field(default_factory=list)
    company_name: str | None = None
    city: str | None = None
    country: str | None = None


SiteOutcome = Literal["written", "not_buyer", "no_valid_snippets", "suppressed", "no_pages", "error", "resolved_away"]


@dataclass
class SiteResult:
    domain: str
    outcome: SiteOutcome
    company_id: str | None = None
    created: bool = False
    country: str | None = None
    evidence_assertion_id: str | None = None
    snippets_dropped: int = 0
    error: str | None = None


@dataclass
class DiscoveryRun:
    run_id: str
    country: str
    hs_heading: str
    reason: str
    queries: int = 0
    queries_failed: int = 0
    results: int = 0
    domains_considered: int = 0
    domains_blocked: int = 0
    domains_suppressed: int = 0
    sites: list[SiteResult] = field(default_factory=list)
    degraded: bool = False

    @property
    def new_companies(self) -> int:
        """Companies created by this run in the run's country (the EV-05 cell)."""
        return sum(1 for s in self.sites if s.outcome == "written" and s.created and s.country == self.country)

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for s in self.sites:
            out[s.outcome] = out.get(s.outcome, 0) + 1
        return out

    def summary(self) -> dict[str, Any]:
        return {
            "runId": self.run_id, "country": self.country, "hsHeading": self.hs_heading, "reason": self.reason,
            "queries": self.queries, "queriesFailed": self.queries_failed, "results": self.results,
            "domainsConsidered": self.domains_considered, "domainsBlocked": self.domains_blocked,
            "domainsSuppressed": self.domains_suppressed, "sites": self.counts(),
            "newCompanies": self.new_companies, "degraded": self.degraded, "discoveryV": DISCOVERY_V,
        }
