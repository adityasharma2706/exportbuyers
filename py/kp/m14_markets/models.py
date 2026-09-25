"""M14 pure logic: market metrics, the SCORE_V=1 score, FTA scope matching and the "why" inputs.

Everything here is deterministic and free of I/O so that the build job, the lazy "why" job and
the tests all compute exactly the same numbers (and therefore the same ``why_input_hash``).
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable, Mapping, Sequence

from .countries import INDIA, WORLD

SCORE_V = 1
W_IMPORT_VALUE = 0.45
W_CAGR = 0.25
W_INDIA_ROOM = 0.15
W_FTA = 0.15
INDIA_SHARE_CAP = 0.5            # [tunable]
MIN_IMPORT_VALUE_USD = 1_000_000  # rows below this are excluded [tunable]
CAGR_YEARS = 5
TOP_SUPPLIERS = 5
WHY_TOP_N = 15                   # "why" generated eagerly for the top N per code
AGGREGATE_SUFFIX = "__"          # HS4 aggregate rows are keyed '<4 digits>__'

HS6_RE = re.compile(r"^[0-9]{6}$")
ROW_CODE_RE = re.compile(r"^([0-9]{6}|[0-9]{4}__)$")
COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
_SCOPE_RE = re.compile(r"^(all|[0-9]{2}(-[0-9]{2})?(,[0-9]{2}(-[0-9]{2})?)*)$")


def aggregate_code(hs6: str) -> str:
    return hs6[:4] + AGGREGATE_SUFFIX


def display_code(row_code: str) -> str:
    """'090111' → '090111'; '0901__' → '0901'."""
    return row_code[:-len(AGGREGATE_SUFFIX)] if row_code.endswith(AGGREGATE_SUFFIX) else row_code


# --------------------------------------------------------------------------------------
# FTA / CEPA table
# --------------------------------------------------------------------------------------

@dataclass(frozen=True)
class FtaEntry:
    partner: str
    agreement: str
    in_force_from: date
    hs_scope: str = "all"
    notes: str | None = None
    source_url: str | None = None

    def chapters(self) -> frozenset[str] | None:
        """None = every chapter."""
        return parse_hs_scope(self.hs_scope)

    def covers(self, row_code: str, as_of: date) -> bool:
        if self.in_force_from > as_of:
            return False
        ch = self.chapters()
        return ch is None or row_code[:2] in ch


def parse_hs_scope(scope: str) -> frozenset[str] | None:
    s = (scope or "").replace(" ", "")
    if not _SCOPE_RE.match(s):
        raise ValueError(f"invalid hs_scope {scope!r}; expected 'all' or a chapters list like '01-24,28'")
    if s == "all":
        return None
    out: set[str] = set()
    for part in s.split(","):
        lo, _, hi = part.partition("-")
        a, b = int(lo), int(hi or lo)
        if a > b or a < 1 or b > 99:
            raise ValueError(f"invalid chapter range {part!r} in hs_scope")
        out.update(f"{c:02d}" for c in range(a, b + 1))
    return frozenset(out)


def fta_for(country: str, row_code: str, ftas: Iterable[FtaEntry], as_of: date) -> FtaEntry | None:
    """The agreement giving India preferential access to ``country`` for this code, if any.
    When several apply, the most recent one in force wins (deeper, later agreements supersede)."""
    hits = [f for f in ftas if f.partner == country and f.covers(row_code, as_of)]
    if not hits:
        return None
    hits.sort(key=lambda f: (-f.in_force_from.toordinal(), f.agreement))
    return hits[0]


# --------------------------------------------------------------------------------------
# Metrics per country × code
# --------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Supplier:
    country: str
    share: float


@dataclass(frozen=True)
class MarketMetrics:
    country: str
    code: str                     # hs6 or '<hs4>__'
    data_year: int
    import_value_usd: int
    cagr_5y: float | None
    india_share: float | None
    top_suppliers: tuple[Supplier, ...]


def cagr(end_value: float, start_value: float, years: int = CAGR_YEARS) -> float | None:
    if years <= 0 or start_value <= 0 or end_value <= 0:
        return None
    v = (end_value / start_value) ** (1.0 / years) - 1.0
    return v if math.isfinite(v) else None


def world_value(partners: Mapping[str, int]) -> int:
    """The reporter's world total: the reported 'WLD' row, else the sum over partners."""
    w = partners.get(WORLD)
    if w is not None and w > 0:
        return int(w)
    return int(sum(v for k, v in partners.items() if k != WORLD))


def compute_metrics(country: str, code: str, by_year: Mapping[int, Mapping[str, int]],
                    data_year: int) -> MarketMetrics | None:
    """``by_year``: year → partner → value (USD). None when there is no import in ``data_year``."""
    cur = by_year.get(data_year)
    if not cur:
        return None
    total = world_value(cur)
    if total <= 0:
        return None
    base = by_year.get(data_year - CAGR_YEARS)
    growth = cagr(total, world_value(base)) if base else None
    india = cur.get(INDIA, 0)
    share = min(1.0, india / total)
    suppliers = sorted(
        ((p, v) for p, v in cur.items() if p != WORLD and not p.startswith("M49:") and v > 0),
        key=lambda pv: (-pv[1], pv[0]),
    )[:TOP_SUPPLIERS]
    # Rounded to 6 places so that the values survive the round trip through `real` columns and the
    # "why" numbers (hence why_input_hash) recomputed from a stored row match the build's.
    return MarketMetrics(
        country=country, code=code, data_year=data_year, import_value_usd=total,
        cagr_5y=None if growth is None else round(growth, 6),
        india_share=round(share, 6),
        top_suppliers=tuple(Supplier(p, round(min(1.0, v / total), 4)) for p, v in suppliers),
    )


# --------------------------------------------------------------------------------------
# Score and ranking (SCORE_V = 1)
# --------------------------------------------------------------------------------------

def pct_rank(values: Sequence[float | None]) -> list[float]:
    """Percent rank in [0, 1] among the non-null values: (#values strictly lower) / (n − 1).
    A single value ranks 1.0; a null ranks 0.0 (no evidence counts as the bottom)."""
    present = sorted(v for v in values if v is not None)
    n = len(present)
    out: list[float] = []
    for v in values:
        if v is None:
            out.append(0.0)
        elif n <= 1:
            out.append(1.0)
        else:
            lower = _count_lower(present, v)
            out.append(lower / (n - 1))
    return out


def _count_lower(sorted_vals: Sequence[float], v: float) -> int:
    lo, hi = 0, len(sorted_vals)
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_vals[mid] < v:
            lo = mid + 1
        else:
            hi = mid
    return lo


def india_share_capped(share: float | None) -> float:
    return min(share or 0.0, INDIA_SHARE_CAP) / INDIA_SHARE_CAP


@dataclass
class ScoredRow:
    metrics: MarketMetrics
    fta: FtaEntry | None
    score: float = 0.0
    rank: int = 0
    why_numbers: dict[str, Any] = field(default_factory=dict)
    why_input_hash: str = ""


def score_code(rows: Sequence[tuple[MarketMetrics, FtaEntry | None]]) -> list[ScoredRow]:
    """Scores and ranks every eligible country for one code. Rows under MIN_IMPORT_VALUE_USD are
    excluded before ranking, so they do not dilute the percent ranks either."""
    eligible = [(m, f) for m, f in rows if m.import_value_usd >= MIN_IMPORT_VALUE_USD]
    pr_value = pct_rank([float(m.import_value_usd) for m, _ in eligible])
    pr_cagr = pct_rank([m.cagr_5y for m, _ in eligible])
    scored: list[ScoredRow] = []
    for (m, f), pv, pc in zip(eligible, pr_value, pr_cagr):
        s = (W_IMPORT_VALUE * pv + W_CAGR * pc + W_INDIA_ROOM * (1.0 - india_share_capped(m.india_share))
             + W_FTA * (1.0 if f is not None else 0.0))
        row = ScoredRow(metrics=m, fta=f, score=round(s, 6))
        row.why_numbers = why_numbers(m, f)
        row.why_input_hash = why_hash(row.why_numbers)
        scored.append(row)
    scored.sort(key=lambda r: (-r.score, -r.metrics.import_value_usd, r.metrics.country))
    for i, r in enumerate(scored, start=1):
        r.rank = i
    return scored


# --------------------------------------------------------------------------------------
# "Why this market" inputs, hash and number post-check
# --------------------------------------------------------------------------------------

def _r1(x: float | None) -> float | None:
    return None if x is None else round(float(x), 1)


def why_numbers(m: MarketMetrics, fta: FtaEntry | None) -> dict[str, Any]:
    """The only facts the summary may use. Also the input of ``why_input_hash``."""
    return {
        "country": m.country,
        "code": display_code(m.code),
        "data_year": m.data_year,
        "import_value_usd_millions": _r1(m.import_value_usd / 1_000_000),
        "cagr_years": CAGR_YEARS,
        "cagr_5y_percent": _r1(None if m.cagr_5y is None else m.cagr_5y * 100),
        "india_share_percent": _r1(None if m.india_share is None else m.india_share * 100),
        "top_suppliers": [{"country": s.country, "share_percent": _r1(s.share * 100)} for s in m.top_suppliers],
        "fta": fta.agreement if fta is not None else None,
    }


def stable_json(v: Any) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def why_hash(numbers: Mapping[str, Any]) -> str:
    return hashlib.sha256(stable_json(numbers).encode("utf-8")).hexdigest()


_NUM_IN_TEXT = re.compile(r"(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?")


def numbers_in_text(text: str) -> list[float]:
    return [float(t.replace(",", "")) for t in _NUM_IN_TEXT.findall(text)]


def _collect_numbers(v: Any, out: set[float]) -> None:
    if isinstance(v, bool) or v is None:
        return
    if isinstance(v, (int, float)):
        if math.isfinite(float(v)):
            out.add(round(float(v), 1))
    elif isinstance(v, str):
        out.update(round(x, 1) for x in numbers_in_text(v))
    elif isinstance(v, Mapping):
        for x in v.values():
            _collect_numbers(x, out)
    elif isinstance(v, (list, tuple)):
        for x in v:
            _collect_numbers(x, out)


def allowed_numbers(numbers: Mapping[str, Any]) -> set[float]:
    out: set[float] = set()
    _collect_numbers(numbers, out)
    return out


def unsupported_numbers(text: str, numbers: Mapping[str, Any]) -> list[float]:
    """Numbers in ``text`` that do not appear in the input (compared to 1 decimal place)."""
    allowed = allowed_numbers(numbers)
    bad: list[float] = []
    for x in numbers_in_text(text):
        r = round(x, 1)
        if not any(abs(r - a) < 0.05 + 1e-9 for a in allowed):
            bad.append(x)
    return bad
