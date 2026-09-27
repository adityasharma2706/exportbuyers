"""M21 US customs batch connector and aggregates — Python public API.

REQ-015, REQ-016, REQ-018 (shipment frequency and origin filters), REQ-019 (volume sort data),
REQ-021 (activity summary), REQ-022 (India / competitor origin for US buyers).

Weekly licensed bill-of-lading ingestion: the vendor's files are landed raw (M08), written as
Parquet (``<lake>/week=YYYY-WW/``), aggregated in DuckDB SQL over the last 12 months per consignee ×
HS heading, resolved to canonical companies (M18) and written to M09 as ``activity_aggregate``
assertions — aggregates only, never individual BOLs. The vendor is behind ``CustomsUsVendor``
(architecture OQ1 still open). Other modules import only from here.
"""
from .config import CustomsUsConfig, get_customs_config, parse_config, set_customs_config_for_testing
from .connector import BOL_ROW_ATTRIBUTE, CustomsUsConnector, bol_row_of
from .hs_infer import HeadingIndex, HsInferer, Inference, infer, pg_heading_index
from .jobs import (
    handle_ingest,
    ingest_idempotency_key,
    register_customs_jobs,
    request_ingest,
    reset_registration_for_testing,
    set_deps_for_testing,
)
from .lake import PARQUET_SCHEMA, ParquetLake, Window, aggregate, default_lake_uri
from .models import (
    ACTIVITY_ATTRIBUTE,
    HS_CONFIDENCE_MIN,
    INGEST_JOB,
    INGEST_SCHEDULE,
    PRODUCER,
    PRODUCER_VERSION,
    BolRow,
    ConsigneeGroup,
    HeadingAggregate,
    IngestRun,
    IngestWeekPayload,
    IsoWeek,
    Supplier,
    source_id_for,
)
from .pipeline import (
    CustomsDeps,
    DeliveryMissing,
    VendorNotConfigured,
    ingest_week,
    key_row,
    merge_aggregates,
    write_aggregates,
)
from .vendor import ColumnMap, CustomsUsVendor, DropVendor, ParseStats, VendorFile, parse_vendor_file

__all__ = [
    "ACTIVITY_ATTRIBUTE",
    "BOL_ROW_ATTRIBUTE",
    "HS_CONFIDENCE_MIN",
    "INGEST_JOB",
    "INGEST_SCHEDULE",
    "PARQUET_SCHEMA",
    "PRODUCER",
    "PRODUCER_VERSION",
    "BolRow",
    "ColumnMap",
    "ConsigneeGroup",
    "CustomsDeps",
    "CustomsUsConfig",
    "CustomsUsConnector",
    "CustomsUsVendor",
    "DeliveryMissing",
    "DropVendor",
    "HeadingAggregate",
    "HeadingIndex",
    "HsInferer",
    "Inference",
    "IngestRun",
    "IngestWeekPayload",
    "IsoWeek",
    "ParquetLake",
    "ParseStats",
    "Supplier",
    "VendorFile",
    "VendorNotConfigured",
    "Window",
    "aggregate",
    "bol_row_of",
    "default_lake_uri",
    "get_customs_config",
    "handle_ingest",
    "infer",
    "ingest_idempotency_key",
    "ingest_week",
    "key_row",
    "merge_aggregates",
    "parse_config",
    "parse_vendor_file",
    "pg_heading_index",
    "register_customs_jobs",
    "request_ingest",
    "reset_registration_for_testing",
    "set_customs_config_for_testing",
    "set_deps_for_testing",
    "source_id_for",
    "write_aggregates",
]
