"""M01 Platform foundation — Python public API (mirrors the TS helpers).

Other knowledge-plane modules import only from here.
"""
from .budget import BUDGET_EXCEEDED_PREFIX, assert_vendor_budget, is_budget_exceeded
from .config import INDIA_REGIONS, PRIMARY_REGION, PlatformConfig, assert_india_region, get_config, is_india_region, load_config
from .cost import flush_costs, pending_cost_events, record_cost, stop_cost_recorder
from .errors import ERROR_HTTP_STATUS, ErrorCode, KpError
from .ids import new_id, uuid7
from .logs import correlation, current_correlation_id, get_logger
from .secrets import get_secret, load_secrets
from .tracing import span

__all__ = [
    "BUDGET_EXCEEDED_PREFIX",
    "ERROR_HTTP_STATUS",
    "INDIA_REGIONS",
    "PRIMARY_REGION",
    "ErrorCode",
    "KpError",
    "PlatformConfig",
    "assert_india_region",
    "assert_vendor_budget",
    "correlation",
    "current_correlation_id",
    "flush_costs",
    "get_config",
    "get_logger",
    "get_secret",
    "is_budget_exceeded",
    "is_india_region",
    "load_config",
    "load_secrets",
    "new_id",
    "pending_cost_events",
    "record_cost",
    "span",
    "stop_cost_recorder",
    "uuid7",
]
