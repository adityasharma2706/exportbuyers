"""m14.build_rows: trade_flow → market_row (metrics, SCORE_V=1 score, rank per code).

Per country, the data year is the latest year that country has reported (reporters publish at
different times). CAGR compares it with the value five years earlier. Each HS6 row is also
rolled up into its HS4 aggregate row ('<4 digits>__'), whose values are the sums of its HS6
children, so a 4-digit search is ranked on exactly the same basis.

A full build stamps every row it writes with the build time and then deletes the rows it did not
write (codes / countries that fell below the threshold or vanished from the data).
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Callable, Sequence

from kp.m01_platform import KpError, get_logger

from .countries import WORLD, target_countries
from .models import (
    CAGR_YEARS,
    WHY_TOP_N,
    FtaEntry,
    MarketMetrics,
    ScoredRow,
    aggregate_code,
    compute_metrics,
    fta_for,
    score_code,
    world_value,
)
from .store import MarketStore

_log = get_logger("kp.m14_markets.build")
WRITE_CHUNK = 20000

# (country, code, why_input_hash) → enqueue a "why" job. Supplied by the job wiring.
WhyEnqueuer = Callable[[Sequence[tuple[str, str, str]]], int]


@dataclass
class BuildResult:
    countries: int
    codes: int
    rows: int
    deleted: int
    why_enqueued: int
    built_at: datetime


def country_metrics(store: MarketStore, country: str, data_year: int) -> list[MarketMetrics]:
    base_year = data_year - CAGR_YEARS
    years = (base_year, data_year)
    child: dict[str, dict[int, dict[str, int]]] = defaultdict(lambda: defaultdict(dict))
    for partner, hs6, year, value in store.flows_for(country, base_year, data_year):
        if year in years:
            child[hs6][year][partner] = child[hs6][year].get(partner, 0) + value
    # HS4 aggregates: sum partner values; the world total is the sum of each child's world total.
    agg: dict[str, dict[int, dict[str, int]]] = defaultdict(lambda: defaultdict(dict))
    for hs6, by_year in child.items():
        a = agg[aggregate_code(hs6)]
        for year, partners in by_year.items():
            bucket = a[year]
            for p, v in partners.items():
                if p != WORLD:
                    bucket[p] = bucket.get(p, 0) + v
            bucket[WORLD] = bucket.get(WORLD, 0) + world_value(partners)
    out: list[MarketMetrics] = []
    for table in (child, agg):
        for code, by_year in table.items():
            m = compute_metrics(country, code, by_year, data_year)
            if m is not None:
                out.append(m)
    return out


def build_rows(
    store: MarketStore,
    *,
    countries: Sequence[str] | None = None,
    as_of: date | None = None,
    enqueue_why: WhyEnqueuer | None = None,
    now: datetime | None = None,
) -> BuildResult:
    built_at = now or datetime.now(timezone.utc)
    today = as_of or built_at.date()
    wanted = list(countries or target_countries())
    hs_version = store.current_hs_version()
    if hs_version is None:
        raise KpError("CONFLICT", "No current HS nomenclature version is loaded (M12); cannot build market rows")
    ftas: list[FtaEntry] = store.ftas()
    latest = store.latest_years(wanted)

    per_code: dict[str, list[tuple[MarketMetrics, FtaEntry | None]]] = defaultdict(list)
    for country in wanted:
        year = latest.get(country)
        if year is None:
            _log.info("no trade data for country; skipped", extra={"country": country})
            continue
        for m in country_metrics(store, country, year):
            per_code[m.code].append((m, fta_for(country, m.code, ftas, today)))

    written = 0
    pending: list[ScoredRow] = []
    for code in sorted(per_code):
        pending.extend(score_code(per_code[code]))
        if len(pending) >= WRITE_CHUNK:
            written += store.write_rows(pending, hs_version, built_at)
            pending = []
    if pending:
        written += store.write_rows(pending, hs_version, built_at)
    deleted = store.delete_rows_built_before(built_at)

    enqueued = 0
    if enqueue_why is not None:
        missing = store.rows_without_why(WHY_TOP_N)
        if missing:
            enqueued = enqueue_why(missing)
    res = BuildResult(countries=len(latest), codes=len(per_code), rows=written, deleted=deleted,
                      why_enqueued=enqueued, built_at=built_at)
    _log.info("market rows built", extra={"countries": res.countries, "codes": res.codes, "rows": res.rows,
                                          "deleted": res.deleted, "why_enqueued": res.why_enqueued})
    return res
