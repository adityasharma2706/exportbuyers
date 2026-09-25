"""M12 HS nomenclature store and loaders — Python public API.

Data for REQ-005, REQ-006, REQ-007 and REQ-009. Other knowledge-plane modules import only from here.

Loaders (M08 ``Connector`` subclasses): ``WcoHsLoader(version)``, ``DgftItcHsLoader(edition)``,
``CorrelationLoader.for_versions(from, to)``. Each ``load(url, store)`` validates the whole table,
embeds descriptions through M03 (batches of 128) and writes the version transactionally, moving
``is_current`` and emitting EV-12 ``nomenclature.version_loaded {version}``.
"""
from .embeddings import EMBED_BATCH_SIZE, embed_rows
from .jobs import (
    LOAD_CORRELATION_JOB,
    LOAD_ITCHS_JOB,
    LOAD_WCO_JOB,
    LoadCorrelationPayload,
    LoadItcHsPayload,
    LoadWcoPayload,
    NomenclatureVersionLoaded,
    register_hs_jobs,
    set_store_factory_for_testing,
)
from .loaders import RATE_CLASS, CorrelationLoader, DgftItcHsLoader, ItcHsCorrelationLoader, WcoHsLoader, itchs_version
from .models import (
    EMBEDDING_DIM,
    EV_NOMENCLATURE_VERSION_LOADED,
    EXPORT_POLICIES,
    HS_LEVELS,
    ITCHS_SOURCE_ID,
    RELATIONS,
    WCO_SOURCE_ID,
    CorrelationPair,
    CorrelationRow,
    HsCodeRow,
    HsLoadError,
    VersionLoadResult,
    corresponding_hs_version,
    derive_relations,
    level_for,
    normalize_code,
    normalize_policy,
    validate_hs_tree,
    validate_national_lines,
    version_family,
)
from .parsers import parse_correlation_table, parse_itchs_schedule, parse_wco_table, read_tables, sniff_format
from .store import HsStore, MemoryHsStore, PgHsStore

__all__ = [
    "EMBEDDING_DIM",
    "EMBED_BATCH_SIZE",
    "EV_NOMENCLATURE_VERSION_LOADED",
    "EXPORT_POLICIES",
    "HS_LEVELS",
    "ITCHS_SOURCE_ID",
    "LOAD_CORRELATION_JOB",
    "LOAD_ITCHS_JOB",
    "LOAD_WCO_JOB",
    "RATE_CLASS",
    "RELATIONS",
    "WCO_SOURCE_ID",
    "CorrelationLoader",
    "CorrelationPair",
    "CorrelationRow",
    "DgftItcHsLoader",
    "HsCodeRow",
    "HsLoadError",
    "HsStore",
    "ItcHsCorrelationLoader",
    "LoadCorrelationPayload",
    "LoadItcHsPayload",
    "LoadWcoPayload",
    "MemoryHsStore",
    "NomenclatureVersionLoaded",
    "PgHsStore",
    "VersionLoadResult",
    "WcoHsLoader",
    "corresponding_hs_version",
    "derive_relations",
    "embed_rows",
    "itchs_version",
    "level_for",
    "normalize_code",
    "normalize_policy",
    "parse_correlation_table",
    "parse_itchs_schedule",
    "parse_wco_table",
    "read_tables",
    "register_hs_jobs",
    "set_store_factory_for_testing",
    "sniff_format",
    "validate_hs_tree",
    "validate_national_lines",
    "version_family",
]
