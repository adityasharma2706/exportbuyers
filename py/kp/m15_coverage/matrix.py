"""M15 recompute: turns evidence counts into coverage cells (RULE_V=1) and stores them.

- ``recompute_cell(store, country, heading)`` recomputes one heading cell and its country fallback.
- ``recompute_all(store, countries=None)`` recomputes the whole matrix (or some countries) and
  removes cells whose evidence has gone.

A cell with no companies at all is removed rather than stored, so reads fall through to the country
fallback and finally to a synthetic ``limited`` cell. Until the store holds buyers every country is
therefore Limited, which is the honest answer.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Sequence

from kp.m01_platform import get_logger

from .rules import COUNTRY_FALLBACK, CoverageCell, build_cell, fresh_cutoff, validate_country, validate_heading
from .store import CoverageStore

_log = get_logger("kp.m15_coverage.matrix")


@dataclass(frozen=True)
class RecomputeResult:
    written: int
    deleted: int
    by_label: dict[str, int]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _tally(cells: Sequence[CoverageCell]) -> dict[str, int]:
    out = {"strong": 0, "partial": 0, "limited": 0}
    for c in cells:
        out[c.label] += 1
    return out


def recompute_cell(store: CoverageStore, country: str, heading: str, *, now: datetime | None = None) -> RecomputeResult:
    country = validate_country(country)
    heading = validate_heading(heading)
    at = now or _now()
    cutoff = fresh_cutoff(at)
    targets = [heading] if heading == COUNTRY_FALLBACK else [heading, COUNTRY_FALLBACK]
    keep: list[CoverageCell] = []
    deleted = 0
    for h in targets:
        counts = store.counts_for_cell(country, h, cutoff)
        if counts.company_count == 0:
            deleted += int(store.delete_cell(country, h))
            continue
        keep.append(build_cell(counts, computed_at=at))
    written = store.upsert_cells(keep)
    res = RecomputeResult(written=written, deleted=deleted, by_label=_tally(keep))
    _log.info("coverage cell recomputed", extra={"country": country, "heading": heading, "written": written,
                                                 "deleted": deleted, "labels": res.by_label})
    return res


def recompute_all(store: CoverageStore, countries: Sequence[str] | None = None, *,
                  now: datetime | None = None) -> RecomputeResult:
    scope = None if countries is None else sorted({validate_country(c) for c in countries})
    at = now or _now()
    cutoff = fresh_cutoff(at)
    cells = [build_cell(c, computed_at=at) for c in store.counts_all(cutoff, scope) if c.company_count > 0]
    written = store.upsert_cells(cells)
    # Every surviving cell now carries computed_at == at; older rows have no evidence left.
    deleted = store.delete_cells_computed_before(at, scope)
    res = RecomputeResult(written=written, deleted=deleted, by_label=_tally(cells))
    _log.info("coverage matrix recomputed", extra={"countries": "all" if scope is None else len(scope),
                                                   "written": written, "deleted": deleted, "labels": res.by_label})
    return res
