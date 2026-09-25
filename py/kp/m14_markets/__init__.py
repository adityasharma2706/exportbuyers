"""M14 Market analytics builder — Python public API (knowledge plane).

Data for REQ-010, REQ-011 and REQ-013. UN Comtrade ingestion into analytics.trade_flow, the curated
FTA/CEPA table, the SCORE_V=1 batch ranking into analytics.market_row, and cached "why this market"
summaries per country × HS6. The serving plane reads rows through the TS module (IF-14a marketRows).
"""
from .build import BuildResult, build_rows, country_metrics
from .comtrade import SOURCE_ID, ComtradeConnector, FlowRow, parse_final_data
from .countries import DEFAULT_TARGET_COUNTRIES, ISO2_TO_M49, M49_TO_ISO2, partner_key, target_countries
from .jobs import (
    BUILD_JOB,
    INGEST_JOB,
    WHY_JOB,
    BuildRowsPayload,
    ComtradeIngestPayload,
    GenerateWhyPayload,
    enqueue_why_jobs,
    ingest_years,
    register_market_jobs,
    set_store_factory_for_testing,
    set_tx_factory_for_testing,
)
from .models import (
    MIN_IMPORT_VALUE_USD,
    SCORE_V,
    WHY_TOP_N,
    FtaEntry,
    MarketMetrics,
    ScoredRow,
    Supplier,
    compute_metrics,
    fta_for,
    parse_hs_scope,
    pct_rank,
    score_code,
    unsupported_numbers,
    why_hash,
    why_numbers,
)
from .store import MarketStore, MemoryMarketStore, PgMarketStore, StoredMarketRow
from .why import WHY_SYSTEM, WhyOutcome, check_why, generate_why, set_llm_for_testing

__all__ = [
    "BUILD_JOB",
    "DEFAULT_TARGET_COUNTRIES",
    "INGEST_JOB",
    "ISO2_TO_M49",
    "M49_TO_ISO2",
    "MIN_IMPORT_VALUE_USD",
    "SCORE_V",
    "SOURCE_ID",
    "WHY_JOB",
    "WHY_SYSTEM",
    "WHY_TOP_N",
    "BuildResult",
    "BuildRowsPayload",
    "ComtradeConnector",
    "ComtradeIngestPayload",
    "FlowRow",
    "FtaEntry",
    "GenerateWhyPayload",
    "MarketMetrics",
    "MarketStore",
    "MemoryMarketStore",
    "PgMarketStore",
    "ScoredRow",
    "StoredMarketRow",
    "Supplier",
    "WhyOutcome",
    "build_rows",
    "check_why",
    "compute_metrics",
    "country_metrics",
    "enqueue_why_jobs",
    "fta_for",
    "generate_why",
    "ingest_years",
    "parse_final_data",
    "parse_hs_scope",
    "partner_key",
    "pct_rank",
    "register_market_jobs",
    "score_code",
    "set_llm_for_testing",
    "set_store_factory_for_testing",
    "set_tx_factory_for_testing",
    "target_countries",
    "unsupported_numbers",
    "why_hash",
    "why_numbers",
]
