"""M14 tests: parsing, metrics, SCORE_V=1 ranking, FTA scope, build with HS4 aggregates, and the
"why" number post-check."""
from __future__ import annotations

import gzip
from datetime import date, datetime, timezone

import pytest

from kp.m03_llm import LlmRequest, LlmResult
from kp.m14_markets import (
    FlowRow,
    FtaEntry,
    MemoryMarketStore,
    build_rows,
    compute_metrics,
    fta_for,
    generate_why,
    parse_final_data,
    parse_hs_scope,
    pct_rank,
    set_llm_for_testing,
    unsupported_numbers,
    why_hash,
)


def test_parse_final_data_filters_and_sums() -> None:
    tsv = (
        "refYear\tperiod\treporterCode\tflowCode\tpartnerCode\tpartner2Code\tcmdCode\tcustomsCode\tmotCode\tqty\tprimaryValue\n"
        "2024\t2024\t842\tM\t0\t0\t090111\tC00\t0\t10\t5000000\n"
        "2024\t2024\t842\tM\t699\t0\t090111\tC00\t0\t2\t1000000\n"
        "2024\t2024\t842\tX\t699\t0\t090111\tC00\t0\t2\t999\n"      # export: dropped
        "2024\t2024\t842\tM\t699\t0\t0901\tC00\t0\t2\t999\n"        # HS4 line: dropped
        "2024\t2024\t842\tM\t156\t0\t090111\tC01\t0\t2\t999\n"      # customs breakdown: dropped
        "2024\t2024\t842\tM\t97\t0\t090111\tC00\t0\t\t50\n"         # aggregate area → M49:97
    )
    rows = {(r.partner, r.hs6): r for r in parse_final_data(gzip.compress(tsv.encode()))}
    assert rows[("WLD", "090111")].value_usd == 5_000_000
    assert rows[("IN", "090111")].reporter == "US"
    assert rows[("M49:97", "090111")].qty is None
    assert len(rows) == 3


def test_metrics_cagr_share_suppliers() -> None:
    m = compute_metrics("US", "090111", {
        2024: {"WLD": 32_000_000, "IN": 3_200_000, "CN": 16_000_000, "VN": 8_000_000, "M49:97": 100},
        2019: {"WLD": 1_000_000},
    }, 2024)
    assert m is not None
    assert m.import_value_usd == 32_000_000
    assert m.cagr_5y == pytest.approx(1.0)  # 32× in 5 years = doubling yearly
    assert m.india_share == pytest.approx(0.1)
    assert [s.country for s in m.top_suppliers] == ["CN", "VN", "IN"]


def test_pct_rank_and_scope() -> None:
    assert pct_rank([1.0, 3.0, 2.0, None]) == [0.0, 1.0, 0.5, 0.0]
    assert pct_rank([7.0]) == [1.0]
    assert parse_hs_scope("all") is None
    assert parse_hs_scope("01-03,28") == frozenset({"01", "02", "03", "28"})
    f = FtaEntry("AE", "CEPA", date(2022, 5, 1), "01-24")
    assert fta_for("AE", "090111", [f], date(2023, 1, 1)) is f
    assert fta_for("AE", "300490", [f], date(2023, 1, 1)) is None
    assert fta_for("AE", "090111", [f], date(2021, 1, 1)) is None


def _store() -> MemoryMarketStore:
    s = MemoryMarketStore()
    flows = []
    for c, v2024, v2019, india in (("US", 50_000_000, 20_000_000, 1_000_000), ("AE", 10_000_000, 2_000_000, 6_000_000),
                                   ("DE", 500_000, 400_000, 0)):
        flows += [FlowRow(c, "WLD", "090111", 2024, v2024, None), FlowRow(c, "WLD", "090111", 2019, v2019, None),
                  FlowRow(c, "WLD", "090112", 2024, v2024, None)]
        if india:
            flows.append(FlowRow(c, "IN", "090111", 2024, india, None))
    s.upsert_flows(flows)
    s.fta_entries = [FtaEntry("AE", "India–UAE CEPA", date(2022, 5, 1))]
    return s


def test_build_ranks_aggregates_and_excludes_small() -> None:
    s = _store()
    enq: list[tuple[str, str, str]] = []
    res = build_rows(s, countries=["US", "AE", "DE"], as_of=date(2025, 1, 1),
                     enqueue_why=lambda items: enq.extend(items) or len(items),
                     now=datetime(2025, 1, 1, tzinfo=timezone.utc))
    assert s.get_row("DE", "090111") is None  # under $1 M
    us, ae = s.get_row("US", "090111"), s.get_row("AE", "090111")
    assert us is not None and ae is not None and {us.rank, ae.rank} == {1, 2}
    agg = s.get_row("US", "0901__")
    assert agg is not None and agg.import_value_usd == 100_000_000
    assert ae.fta_ref == "India–UAE CEPA"
    assert res.why_enqueued == len(enq) and ("US", "090111", us.why_input_hash) in enq


def test_why_post_check_and_hash_guard() -> None:
    numbers = {"import_value_usd_millions": 50.0, "cagr_years": 5, "cagr_5y_percent": 20.1, "data_year": 2024}
    assert unsupported_numbers("Imports of 50 million grew 20.1% a year over 5 years to 2024.", numbers) == []
    assert unsupported_numbers("Imports reached $51.2 million.", numbers) == [51.2]
    assert why_hash(numbers) == why_hash(dict(reversed(list(numbers.items()))))

    s = _store()
    build_rows(s, countries=["US", "AE"], as_of=date(2025, 1, 1), now=datetime(2025, 1, 1, tzinfo=timezone.utc))
    row = s.get_row("US", "090111")
    assert row is not None

    def fake(text: str):  # noqa: ANN202
        def call(req: LlmRequest) -> LlmResult:
            return LlmResult(text=text, model="t", input_tokens=1, output_tokens=1, cached=False, json={"text": text})
        return call

    try:
        set_llm_for_testing(fake("The US imported 999 million."))
        assert generate_why(s, "US", "090111").status == "rejected"
        assert s.get_row("US", "090111").why_text is None  # type: ignore[union-attr]
        set_llm_for_testing(fake("The United States imported 50 million dollars of this product in 2024."))
        out = generate_why(s, "US", "090111", expected_hash=row.why_input_hash)
        assert out.status == "generated"
        assert generate_why(s, "US", "090111", expected_hash="0" * 64).status == "stale"
    finally:
        set_llm_for_testing(None)
