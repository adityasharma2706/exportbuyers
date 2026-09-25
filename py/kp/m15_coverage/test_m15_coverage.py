"""M15 unit tests over the in-memory store."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from kp.m15_coverage import (
    COUNTRY_FALLBACK,
    KEY_LIMITED,
    KEY_PARTIAL_FEW,
    KEY_PARTIAL_WEB_ONLY,
    KEY_STRONG_CUSTOMS,
    MemoryCoverageStore,
    MemoryEvidence,
    classify,
    debounce_window,
    parse_discovery_completed,
    recompute_all,
    recompute_cell,
)

NOW = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
FRESH = NOW - timedelta(days=10)
STALE = NOW - timedelta(days=200)


def _add(store: MemoryCoverageStore, n: int, *, country: str = "DE", heading: str = "0901",
         source: str = "customs", checked: datetime = FRESH, prefix: str = "c") -> None:
    for i in range(n):
        store.evidence.append(MemoryEvidence(company_id=f"{prefix}{i}", country=country, hs_heading=heading,
                                             source_type=source, checked_at=checked))


def test_rule_thresholds() -> None:
    assert classify(["customs"], 50) == ("strong", KEY_STRONG_CUSTOMS)
    assert classify(["customs"], 49) == ("partial", KEY_PARTIAL_FEW)
    assert classify(["website", "directory"], 500) == ("partial", KEY_PARTIAL_WEB_ONLY)
    assert classify(["website"], 9) == ("limited", KEY_LIMITED)
    assert classify([], 0) == ("limited", KEY_LIMITED)


def test_empty_store_every_country_limited() -> None:
    store = MemoryCoverageStore()
    res = recompute_all(store, now=NOW)
    assert res.written == 0
    assert store.cells == {}


def test_freshness_and_fallback() -> None:
    store = MemoryCoverageStore()
    _add(store, 40, source="customs", prefix="a")
    _add(store, 20, source="website", checked=STALE, prefix="b")
    _add(store, 15, heading="0902", source="customs", prefix="d")
    recompute_all(store, now=NOW)
    cell = store.get_cell("DE", "0901")
    assert cell is not None
    assert (cell.company_count, cell.fresh_company_count) == (60, 40)
    assert cell.label == "partial" and cell.explanation_key == KEY_PARTIAL_FEW
    assert cell.params == {"count": 40, "sources": ["customs", "web"]}
    fb = store.get_cell("DE", COUNTRY_FALLBACK)
    assert fb is not None and fb.fresh_company_count == 55 and fb.label == "strong"


def test_cell_recompute_removes_empty_cells() -> None:
    store = MemoryCoverageStore()
    _add(store, 12, source="directory")
    recompute_cell(store, "DE", "0901", now=NOW)
    assert store.get_cell("DE", "0901") is not None
    store.evidence.clear()
    res = recompute_cell(store, "de", "0901", now=NOW)
    assert res.deleted == 2
    assert store.get_cell("DE", "0901") is None and store.get_cell("DE", COUNTRY_FALLBACK) is None


def test_excluded_evidence() -> None:
    store = MemoryCoverageStore()
    store.evidence += [
        MemoryEvidence("x1", "DE", "0901", "customs", FRESH, active=False),
        MemoryEvidence("x2", "DE", "0901", "customs", FRESH, polarity="negative"),
        MemoryEvidence("x3", "DE", "0901", "customs", FRESH, can_display=False),
        MemoryEvidence("x4", "DE", "0901", "customs", FRESH, company_status="closed"),
        MemoryEvidence("x5", "DE", "0901", "customs", FRESH, attribute="buyer_type"),
    ]
    recompute_all(store, now=NOW)
    assert store.cells == {}


def test_debounce_and_event_parse() -> None:
    a, end_a = debounce_window(datetime(2026, 9, 1, 12, 1, tzinfo=timezone.utc))
    b, _ = debounce_window(datetime(2026, 9, 1, 12, 4, 59, tzinfo=timezone.utc))
    c, _ = debounce_window(datetime(2026, 9, 1, 12, 5, tzinfo=timezone.utc))
    assert a == b != c
    assert end_a == datetime(2026, 9, 1, 12, 5, tzinfo=timezone.utc)
    assert parse_discovery_completed({"country": "de", "hsHeading": "090111"}) == ("DE", "0901")
    assert parse_discovery_completed({"country": "DE"}) is None
    with pytest.raises(ValueError):
        recompute_cell(MemoryCoverageStore(), "Germany", "0901")
