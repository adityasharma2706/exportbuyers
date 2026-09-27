"""M23 Registry and domain-signal connectors — Python public API (IF-23a).

Enabling REQ-027 and REQ-030 (trust checks in M24) and the entity anchors M18 resolves on.

    registry_lookup(name, country) -> RegistryMatch | Unavailable   # GLEIF, Companies House (GB), OpenCorporates
    vat_check(vat) -> VatResult | Unavailable                       # EU VIES
    domain_signals(domain) -> DomainSignals                         # age_days|None, has_mx, is_freemail, rdap_available

On-demand, cached in Redis (registry 30 days, domain 7 days) and rate-limited per vendor.
``Unavailable`` is a value, not an exception, so callers can map it to ``unknown``.
Other knowledge-plane modules import only from here.
"""
from .api import MIN_MATCH, STRONG_MATCH, domain_signals, registry_lookup, vat_check
from .cache import (
    DOMAIN_TTL_S,
    REGISTRY_TTL_S,
    Cache,
    MemoryCache,
    RedisCache,
    set_cache_for_testing,
)
from .domain import (
    SOURCE_DNS,
    SOURCE_RDAP,
    SOURCE_WHOIS,
    InvalidDomain,
    normalise_domain,
    rdap_bootstrap,
    reset_whois_servers_for_testing,
    set_mx_lookup_for_testing,
    set_whois_transport_for_testing,
)
from .evidence import record_domain_signals, record_registry_match, record_vat_result
from .freemail import (
    CORE_FREEMAIL,
    SOURCE_FREEMAIL,
    FreemailList,
    is_freemail,
    refresh_freemail,
    set_freemail_list_for_testing,
)
from .jobs import FREEMAIL_REFRESH_JOB, register_registry_jobs, reset_registration_for_testing
from .models import (
    REGISTRY_STATUSES,
    DomainSignals,
    RegistryCandidate,
    RegistryMatch,
    Unavailable,
    VatResult,
    is_unavailable,
)
from .names import name_similarity, normalise_name
from .ratelimit import VENDOR_RATES, RateLimiter, VendorRate, set_limiter_for_testing
from .registries import SOURCE_COMPANIES_HOUSE, SOURCE_GLEIF, SOURCE_OPENCORPORATES
from .vies import SOURCE_VIES, VIES_MEMBER_STATES

__all__ = [
    "CORE_FREEMAIL",
    "DOMAIN_TTL_S",
    "FREEMAIL_REFRESH_JOB",
    "MIN_MATCH",
    "REGISTRY_STATUSES",
    "REGISTRY_TTL_S",
    "SOURCE_COMPANIES_HOUSE",
    "SOURCE_DNS",
    "SOURCE_FREEMAIL",
    "SOURCE_GLEIF",
    "SOURCE_OPENCORPORATES",
    "SOURCE_RDAP",
    "SOURCE_VIES",
    "SOURCE_WHOIS",
    "STRONG_MATCH",
    "VENDOR_RATES",
    "VIES_MEMBER_STATES",
    "Cache",
    "DomainSignals",
    "FreemailList",
    "InvalidDomain",
    "MemoryCache",
    "RateLimiter",
    "RedisCache",
    "RegistryCandidate",
    "RegistryMatch",
    "Unavailable",
    "VatResult",
    "VendorRate",
    "domain_signals",
    "is_freemail",
    "is_unavailable",
    "name_similarity",
    "normalise_domain",
    "normalise_name",
    "rdap_bootstrap",
    "record_domain_signals",
    "record_registry_match",
    "record_vat_result",
    "refresh_freemail",
    "register_registry_jobs",
    "registry_lookup",
    "reset_registration_for_testing",
    "reset_whois_servers_for_testing",
    "set_cache_for_testing",
    "set_freemail_list_for_testing",
    "set_limiter_for_testing",
    "set_mx_lookup_for_testing",
    "set_whois_transport_for_testing",
    "vat_check",
]
