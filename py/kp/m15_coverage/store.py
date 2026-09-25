"""M15 persistence: reads evidence counts from knowledge.assertion / knowledge.company (M09) and
writes knowledge.coverage_cell (psycopg 3). Also an in-memory store for tests and dry runs."""
from __future__ import annotations

import json
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterator, Protocol, Sequence

from kp.m01_platform import get_secret

from .rules import COUNTRY_FALLBACK, EVIDENCE_ATTRIBUTES, CellCounts, CoverageCell

BATCH = 2000

# Active, displayable, positive evidence that ties an active company to a heading.
_EVIDENCE_FROM = """
  from knowledge.assertion a
  join knowledge.company c on c.id = a.subject_id
 where a.subject_type = 'company'
   and a.superseded_by is null
   and a.polarity = 'positive'
   and a.can_display
   and a.attribute = any(%(attrs)s)
   and a.hs_heading is not null
   and c.status = 'active'
"""

_COUNT_COLUMNS = """
  coalesce(array_agg(distinct a.source_type) filter (where a.source_type is not null), '{}') as source_types,
  count(distinct c.id) as company_count,
  count(distinct c.id) filter (where a.checked_at >= %(cutoff)s) as fresh_company_count
"""


class CoverageStore(Protocol):
    def counts_for_cell(self, country: str, heading: str, cutoff: datetime) -> CellCounts: ...
    def counts_all(self, cutoff: datetime, countries: Sequence[str] | None) -> list[CellCounts]: ...
    def upsert_cells(self, cells: Sequence[CoverageCell]) -> int: ...
    def delete_cell(self, country: str, heading: str) -> bool: ...
    def delete_cells_computed_before(self, before: datetime, countries: Sequence[str] | None) -> int: ...
    def get_cell(self, country: str, heading: str) -> CoverageCell | None: ...


def _cell_params(c: CoverageCell) -> tuple[Any, ...]:
    return (c.country, c.hs_heading, list(c.source_types), c.company_count, c.fresh_company_count, c.label,
            c.explanation_key, json.dumps(c.params, separators=(",", ":")), c.rule_version, c.computed_at)


class PgCoverageStore:
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

    def counts_for_cell(self, country: str, heading: str, cutoff: datetime) -> CellCounts:
        params: dict[str, Any] = {"attrs": list(EVIDENCE_ATTRIBUTES), "cutoff": cutoff, "country": country}
        where = " and c.country = %(country)s"
        if heading != COUNTRY_FALLBACK:
            where += " and a.hs_heading = %(heading)s"
            params["heading"] = heading
        with self._connection() as conn:
            row = conn.execute(f"select {_COUNT_COLUMNS} {_EVIDENCE_FROM} {where}", params).fetchone()
        types, total, fresh = (row or ([], 0, 0))
        return CellCounts(country=country, hs_heading=heading, source_types=tuple(types or ()),
                          company_count=int(total or 0), fresh_company_count=int(fresh or 0))

    def counts_all(self, cutoff: datetime, countries: Sequence[str] | None) -> list[CellCounts]:
        params: dict[str, Any] = {"attrs": list(EVIDENCE_ATTRIBUTES), "cutoff": cutoff}
        where = ""
        if countries is not None:
            where = " and c.country = any(%(countries)s)"
            params["countries"] = list(countries)
        with self._connection() as conn:
            per_heading = conn.execute(
                f"select c.country, a.hs_heading, {_COUNT_COLUMNS} {_EVIDENCE_FROM} {where} "
                "group by c.country, a.hs_heading",
                params,
            ).fetchall()
            per_country = conn.execute(
                f"select c.country, {_COUNT_COLUMNS} {_EVIDENCE_FROM} {where} group by c.country",
                params,
            ).fetchall()
        out = [CellCounts(country=r[0], hs_heading=r[1], source_types=tuple(r[2] or ()),
                          company_count=int(r[3]), fresh_company_count=int(r[4])) for r in per_heading]
        out += [CellCounts(country=r[0], hs_heading=COUNTRY_FALLBACK, source_types=tuple(r[1] or ()),
                           company_count=int(r[2]), fresh_company_count=int(r[3])) for r in per_country]
        return out

    def upsert_cells(self, cells: Sequence[CoverageCell]) -> int:
        if not cells:
            return 0
        with self._connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    for i in range(0, len(cells), BATCH):
                        cur.executemany(
                            "insert into knowledge.coverage_cell (country, hs_heading, source_types, company_count, "
                            "fresh_company_count, label, explanation_key, params, rule_version, computed_at) "
                            "values (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, coalesce(%s::timestamptz, now())) "
                            "on conflict (country, hs_heading) do update set "
                            "source_types = excluded.source_types, company_count = excluded.company_count, "
                            "fresh_company_count = excluded.fresh_company_count, label = excluded.label, "
                            "explanation_key = excluded.explanation_key, params = excluded.params, "
                            "rule_version = excluded.rule_version, computed_at = excluded.computed_at",
                            [_cell_params(c) for c in cells[i:i + BATCH]],
                        )
        return len(cells)

    def delete_cell(self, country: str, heading: str) -> bool:
        with self._connection() as conn:
            with conn.transaction():
                cur = conn.execute(
                    "delete from knowledge.coverage_cell where country = %s and hs_heading = %s", (country, heading)
                )
                return bool(cur.rowcount)

    def delete_cells_computed_before(self, before: datetime, countries: Sequence[str] | None) -> int:
        with self._connection() as conn:
            with conn.transaction():
                if countries is None:
                    cur = conn.execute("delete from knowledge.coverage_cell where computed_at < %s", (before,))
                else:
                    cur = conn.execute(
                        "delete from knowledge.coverage_cell where computed_at < %s and country = any(%s)",
                        (before, list(countries)),
                    )
                return int(cur.rowcount or 0)

    def get_cell(self, country: str, heading: str) -> CoverageCell | None:
        with self._connection() as conn:
            r = conn.execute(
                "select country, hs_heading, source_types, company_count, fresh_company_count, label, "
                "explanation_key, params, rule_version, computed_at from knowledge.coverage_cell "
                "where country = %s and hs_heading = %s",
                (country, heading),
            ).fetchone()
        if r is None:
            return None
        params = r[7] if isinstance(r[7], dict) else json.loads(r[7] or "{}")
        return CoverageCell(country=r[0], hs_heading=r[1], source_types=tuple(r[2] or ()), company_count=int(r[3]),
                            fresh_company_count=int(r[4]), label=r[5], explanation_key=r[6], params=params,
                            rule_version=int(r[8]), computed_at=r[9])


@dataclass(frozen=True)
class MemoryEvidence:
    """One evidence assertion as the memory store sees it."""

    company_id: str
    country: str
    hs_heading: str
    source_type: str
    checked_at: datetime
    attribute: str = "product_evidence"
    polarity: str = "positive"
    can_display: bool = True
    active: bool = True            # superseded_by is null
    company_status: str = "active"


class MemoryCoverageStore:
    """In-memory CoverageStore with the same semantics as the SQL."""

    def __init__(self) -> None:
        self.evidence: list[MemoryEvidence] = []
        self.cells: dict[tuple[str, str], CoverageCell] = {}

    def _eligible(self) -> list[MemoryEvidence]:
        return [e for e in self.evidence
                if e.active and e.polarity == "positive" and e.can_display and e.attribute in EVIDENCE_ATTRIBUTES
                and e.company_status == "active" and e.hs_heading]

    @staticmethod
    def _count(country: str, heading: str, rows: list[MemoryEvidence], cutoff: datetime) -> CellCounts:
        return CellCounts(
            country=country, hs_heading=heading,
            source_types=tuple(sorted({e.source_type for e in rows if e.source_type})),
            company_count=len({e.company_id for e in rows}),
            fresh_company_count=len({e.company_id for e in rows if e.checked_at >= cutoff}),
        )

    def counts_for_cell(self, country: str, heading: str, cutoff: datetime) -> CellCounts:
        rows = [e for e in self._eligible() if e.country == country
                and (heading == COUNTRY_FALLBACK or e.hs_heading == heading)]
        return self._count(country, heading, rows, cutoff)

    def counts_all(self, cutoff: datetime, countries: Sequence[str] | None) -> list[CellCounts]:
        rows = [e for e in self._eligible() if countries is None or e.country in countries]
        groups: dict[tuple[str, str], list[MemoryEvidence]] = {}
        for e in rows:
            groups.setdefault((e.country, e.hs_heading), []).append(e)
            groups.setdefault((e.country, COUNTRY_FALLBACK), []).append(e)
        return [self._count(c, h, g, cutoff) for (c, h), g in sorted(groups.items())]

    def upsert_cells(self, cells: Sequence[CoverageCell]) -> int:
        for c in cells:
            self.cells[(c.country, c.hs_heading)] = c
        return len(cells)

    def delete_cell(self, country: str, heading: str) -> bool:
        return self.cells.pop((country, heading), None) is not None

    def delete_cells_computed_before(self, before: datetime, countries: Sequence[str] | None) -> int:
        stale = [k for k, c in self.cells.items()
                 if (c.computed_at is None or c.computed_at < before) and (countries is None or k[0] in countries)]
        for k in stale:
            del self.cells[k]
        return len(stale)

    def get_cell(self, country: str, heading: str) -> CoverageCell | None:
        return self.cells.get((country, heading))
