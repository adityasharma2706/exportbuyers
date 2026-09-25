"""M14 persistence: analytics.trade_flow / market_row / fta (psycopg 3), plus an in-memory store."""
from __future__ import annotations

import json
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Iterator, Protocol, Sequence

from kp.m01_platform import get_logger, get_secret

from .comtrade import FlowRow
from .models import FtaEntry, ScoredRow

_log = get_logger("kp.m14_markets.store")
BATCH = 5000


@dataclass(frozen=True)
class StoredMarketRow:
    country: str
    code: str
    data_year: int
    import_value_usd: int
    cagr_5y: float | None
    india_share: float | None
    top_suppliers: list[dict[str, Any]]
    fta_ref: str | None
    score: float
    rank: int
    why_text: str | None
    why_input_hash: str
    hs_version: str


class MarketStore(Protocol):
    def upsert_flows(self, rows: Sequence[FlowRow]) -> int: ...
    def latest_years(self, countries: Sequence[str]) -> dict[str, int]: ...
    def flows_for(self, country: str, first_year: int, last_year: int) -> Iterator[tuple[str, str, int, int]]: ...
    def ftas(self) -> list[FtaEntry]: ...
    def current_hs_version(self) -> str | None: ...
    def write_rows(self, rows: Sequence[ScoredRow], hs_version: str, built_at: datetime) -> int: ...
    def delete_rows_built_before(self, built_at: datetime) -> int: ...
    def rows_without_why(self, max_rank: int) -> list[tuple[str, str, str]]: ...
    def get_row(self, country: str, code: str) -> StoredMarketRow | None: ...
    def set_why(self, country: str, code: str, input_hash: str, text: str | None) -> bool: ...


def _row_params(r: ScoredRow, hs_version: str, built_at: datetime) -> tuple[Any, ...]:
    m = r.metrics
    suppliers = json.dumps([{"country": s.country, "share": s.share} for s in m.top_suppliers])
    return (m.country, m.code, m.data_year, m.import_value_usd, m.cagr_5y, m.india_share, suppliers,
            r.fta.agreement if r.fta else None, r.score, r.rank, r.why_input_hash, hs_version, built_at)


class PgMarketStore:
    """Opens a short connection per operation unless one is supplied."""

    def __init__(self, conn: Any | None = None, dsn: str | None = None) -> None:
        self._conn = conn
        self._dsn = dsn

    @contextmanager
    def _connection(self) -> Iterator[Any]:
        if self._conn is not None:
            yield self._conn
            return
        import psycopg

        with psycopg.connect(self._dsn or get_secret("DATABASE_URL")) as conn:
            yield conn

    def upsert_flows(self, rows: Sequence[FlowRow]) -> int:
        if not rows:
            return 0
        with self._connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    for i in range(0, len(rows), BATCH):
                        cur.executemany(
                            "insert into analytics.trade_flow (reporter, partner, hs6, year, value_usd, qty, ingested_at) "
                            "values (%s, %s, %s, %s, %s, %s, now()) "
                            "on conflict (reporter, partner, hs6, year) do update set "
                            "value_usd = excluded.value_usd, qty = excluded.qty, ingested_at = excluded.ingested_at",
                            [(f.reporter, f.partner, f.hs6, f.year, f.value_usd, f.qty) for f in rows[i:i + BATCH]],
                        )
        return len(rows)

    def latest_years(self, countries: Sequence[str]) -> dict[str, int]:
        with self._connection() as conn:
            rows = conn.execute(
                "select reporter, max(year) from analytics.trade_flow where reporter = any(%s) group by reporter",
                (list(countries),),
            ).fetchall()
        return {r[0]: int(r[1]) for r in rows if r[1] is not None}

    def flows_for(self, country: str, first_year: int, last_year: int) -> Iterator[tuple[str, str, int, int]]:
        with self._connection() as conn:
            with conn.cursor(name="m14_flows") as cur:
                cur.itersize = 20000
                cur.execute(
                    "select partner, hs6, year, value_usd from analytics.trade_flow "
                    "where reporter = %s and year between %s and %s",
                    (country, first_year, last_year),
                )
                for partner, hs6, year, value in cur:
                    yield partner, hs6, int(year), int(value)

    def ftas(self) -> list[FtaEntry]:
        with self._connection() as conn:
            rows = conn.execute(
                "select partner, agreement, in_force_from, hs_scope, notes, source_url from analytics.fta",
            ).fetchall()
        return [FtaEntry(partner=r[0], agreement=r[1], in_force_from=r[2], hs_scope=r[3], notes=r[4],
                         source_url=r[5]) for r in rows]

    def current_hs_version(self) -> str | None:
        with self._connection() as conn:
            row = conn.execute(
                "select version from knowledge.hs_version where is_current and version ~ '^HS[0-9]{4}$' limit 1",
            ).fetchone()
        return row[0] if row else None

    def write_rows(self, rows: Sequence[ScoredRow], hs_version: str, built_at: datetime) -> int:
        if not rows:
            return 0
        with self._connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    for i in range(0, len(rows), BATCH):
                        cur.executemany(
                            "insert into analytics.market_row (country, hs6, data_year, import_value_usd, cagr_5y, "
                            "india_share, top_suppliers, fta_ref, score, rank, why_text, why_input_hash, hs_version, "
                            "built_at) values (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, null, %s, %s, %s) "
                            "on conflict (country, hs6) do update set "
                            "data_year = excluded.data_year, import_value_usd = excluded.import_value_usd, "
                            "cagr_5y = excluded.cagr_5y, india_share = excluded.india_share, "
                            "top_suppliers = excluded.top_suppliers, fta_ref = excluded.fta_ref, "
                            "score = excluded.score, rank = excluded.rank, "
                            # The summary survives only while it describes exactly these numbers.
                            "why_text = case when analytics.market_row.why_input_hash = excluded.why_input_hash "
                            "then analytics.market_row.why_text else null end, "
                            "why_input_hash = excluded.why_input_hash, hs_version = excluded.hs_version, "
                            "built_at = excluded.built_at",
                            [_row_params(r, hs_version, built_at) for r in rows[i:i + BATCH]],
                        )
        return len(rows)

    def delete_rows_built_before(self, built_at: datetime) -> int:
        with self._connection() as conn:
            with conn.transaction():
                cur = conn.execute("delete from analytics.market_row where built_at < %s", (built_at,))
                return int(cur.rowcount or 0)

    def rows_without_why(self, max_rank: int) -> list[tuple[str, str, str]]:
        with self._connection() as conn:
            rows = conn.execute(
                "select country, hs6, why_input_hash from analytics.market_row "
                "where why_text is null and rank <= %s order by hs6, rank",
                (max_rank,),
            ).fetchall()
        return [(r[0], r[1], r[2]) for r in rows]

    def get_row(self, country: str, code: str) -> StoredMarketRow | None:
        with self._connection() as conn:
            r = conn.execute(
                "select country, hs6, data_year, import_value_usd, cagr_5y, india_share, top_suppliers, fta_ref, "
                "score, rank, why_text, why_input_hash, hs_version from analytics.market_row "
                "where country = %s and hs6 = %s",
                (country, code),
            ).fetchone()
        if r is None:
            return None
        suppliers = r[6] if isinstance(r[6], list) else json.loads(r[6] or "[]")
        return StoredMarketRow(country=r[0], code=r[1], data_year=int(r[2]), import_value_usd=int(r[3]),
                               cagr_5y=r[4], india_share=r[5], top_suppliers=suppliers, fta_ref=r[7],
                               score=float(r[8]), rank=int(r[9]), why_text=r[10], why_input_hash=r[11],
                               hs_version=r[12])

    def set_why(self, country: str, code: str, input_hash: str, text: str | None) -> bool:
        with self._connection() as conn:
            with conn.transaction():
                cur = conn.execute(
                    "update analytics.market_row set why_text = %s "
                    "where country = %s and hs6 = %s and why_input_hash = %s",
                    (text, country, code, input_hash),
                )
                return bool(cur.rowcount)


class MemoryMarketStore:
    """In-memory MarketStore for tests and dry runs."""

    def __init__(self, hs_version: str | None = "HS2022") -> None:
        self.flows: dict[tuple[str, str, str, int], int] = {}
        self.fta_entries: list[FtaEntry] = []
        self.rows: dict[tuple[str, str], tuple[StoredMarketRow, datetime]] = {}
        self.hs_version = hs_version

    def upsert_flows(self, rows: Sequence[FlowRow]) -> int:
        for f in rows:
            self.flows[(f.reporter, f.partner, f.hs6, f.year)] = f.value_usd
        return len(rows)

    def latest_years(self, countries: Sequence[str]) -> dict[str, int]:
        out: dict[str, int] = {}
        for (rep, _p, _h, y) in self.flows:
            if rep in countries:
                out[rep] = max(out.get(rep, y), y)
        return out

    def flows_for(self, country: str, first_year: int, last_year: int) -> Iterator[tuple[str, str, int, int]]:
        for (rep, p, h, y), v in list(self.flows.items()):
            if rep == country and first_year <= y <= last_year:
                yield p, h, y, v

    def ftas(self) -> list[FtaEntry]:
        return list(self.fta_entries)

    def current_hs_version(self) -> str | None:
        return self.hs_version

    def write_rows(self, rows: Sequence[ScoredRow], hs_version: str, built_at: datetime) -> int:
        for r in rows:
            m = r.metrics
            old = self.rows.get((m.country, m.code))
            why = old[0].why_text if old and old[0].why_input_hash == r.why_input_hash else None
            self.rows[(m.country, m.code)] = (StoredMarketRow(
                country=m.country, code=m.code, data_year=m.data_year, import_value_usd=m.import_value_usd,
                cagr_5y=m.cagr_5y, india_share=m.india_share,
                top_suppliers=[{"country": s.country, "share": s.share} for s in m.top_suppliers],
                fta_ref=r.fta.agreement if r.fta else None, score=r.score, rank=r.rank, why_text=why,
                why_input_hash=r.why_input_hash, hs_version=hs_version,
            ), built_at)
        return len(rows)

    def delete_rows_built_before(self, built_at: datetime) -> int:
        stale = [k for k, (_r, at) in self.rows.items() if at < built_at]
        for k in stale:
            del self.rows[k]
        return len(stale)

    def rows_without_why(self, max_rank: int) -> list[tuple[str, str, str]]:
        out = [(r.country, r.code, r.why_input_hash) for r, _ in self.rows.values()
               if r.why_text is None and r.rank <= max_rank]
        return sorted(out, key=lambda t: (t[1], self.rows[(t[0], t[1])][0].rank))

    def get_row(self, country: str, code: str) -> StoredMarketRow | None:
        hit = self.rows.get((country, code))
        return hit[0] if hit else None

    def set_why(self, country: str, code: str, input_hash: str, text: str | None) -> bool:
        hit = self.rows.get((country, code))
        if hit is None or hit[0].why_input_hash != input_hash:
            return False
        from dataclasses import replace

        self.rows[(country, code)] = (replace(hit[0], why_text=text), hit[1])
        return True


def fta_by_agreement(ftas: Sequence[FtaEntry], country: str, agreement: str | None) -> FtaEntry | None:
    if agreement is None:
        return None
    for f in ftas:
        if f.partner == country and f.agreement == agreement:
            return f
    # The table changed after the build; keep the reference so the hash stays reproducible.
    return FtaEntry(partner=country, agreement=agreement, in_force_from=date.min)
