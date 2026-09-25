"""M17 fuzzy matching.

    score = max(token_sort_ratio, jaro_winkler × 100)  over every (query name, entry name) pair
            + 5 when the query country is one of the entry's countries   (capped at 100)
    hit       score ≥ 95   [tunable]
    possible  85 ≤ score < 95
    clear     otherwise
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

from rapidfuzz import fuzz
from rapidfuzz.distance import JaroWinkler

from .models import Match, SanctionsEntry

HIT_THRESHOLD = 95.0       # [tunable]
POSSIBLE_THRESHOLD = 85.0  # [tunable]
COUNTRY_BONUS = 5.0
TRIGRAM_PREFILTER = 0.3
MAX_REPORTED_MATCHES = 20


def configure_thresholds(*, hit: float | None = None, possible: float | None = None) -> None:
    """Runtime tuning (tests, ops). ``possible`` must stay below ``hit``."""
    global HIT_THRESHOLD, POSSIBLE_THRESHOLD
    h = HIT_THRESHOLD if hit is None else float(hit)
    p = POSSIBLE_THRESHOLD if possible is None else float(possible)
    if not 0 < p < h <= 100:
        raise ValueError("thresholds must satisfy 0 < possible < hit <= 100")
    HIT_THRESHOLD, POSSIBLE_THRESHOLD = h, p


def name_score(a: str, b: str) -> float:
    """Similarity of two normalised names on a 0–100 scale."""
    if not a or not b:
        return 0.0
    tsr = float(fuzz.token_sort_ratio(a, b))
    jw = float(JaroWinkler.similarity(a, b)) * 100.0
    return max(tsr, jw)


def entry_score(query_norms: Sequence[str], country: str | None, entry: SanctionsEntry) -> tuple[float, str]:
    """Best score of ``entry`` against any query name, and the entry name that produced it."""
    best, best_name = 0.0, ""
    for i, en in enumerate(entry.names_norm):
        for q in query_norms:
            s = name_score(q, en)
            if s > best:
                best = s
                best_name = entry.names[i] if i < len(entry.names) else en
    if best > 0 and country and country.upper() in entry.countries:
        best += COUNTRY_BONUS
    return min(best, 100.0), best_name


def classify(score: float) -> str:
    if score >= HIT_THRESHOLD:
        return "hit"
    if score >= POSSIBLE_THRESHOLD:
        return "possible"
    return "clear"


@dataclass(frozen=True)
class Evaluation:
    result: str
    best_score: float
    matches: tuple[Match, ...]   # every candidate at or above the possible threshold, best first

    @property
    def matched_entry_ids(self) -> list[str]:
        return [m.entry_id for m in self.matches]


def evaluate(query_norms: Sequence[str], country: str | None, candidates: Iterable[SanctionsEntry]) -> Evaluation:
    qs = [q for q in dict.fromkeys(query_norms) if q]
    if not qs:
        return Evaluation("clear", 0.0, ())
    best = 0.0
    matches: list[Match] = []
    for e in candidates:
        if not e.active:
            continue
        s, name = entry_score(qs, country, e)
        best = max(best, s)
        if s >= POSSIBLE_THRESHOLD:
            matches.append(Match(entry_id=e.id, list=e.list, list_uid=e.list_uid, name=name, score=s))
    matches.sort(key=lambda m: (-m.score, m.list, m.list_uid))
    return Evaluation(classify(best), round(best, 2), tuple(matches))
