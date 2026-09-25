"""Cached LLM "why this market" summaries per country × code (LLD M14 "Why").

The prompt carries only the row's numbers and forbids any others. After generation every number
in the text must appear in the input (compared to 1 decimal place); otherwise ``why_text`` stays
null and the UI shows its template sentence. The text is written only if the row still carries
the same ``why_input_hash`` (a rebuild in between invalidates it), and is regenerated only when
that hash changes. LLM responses are additionally cached by M03 (cacheable requests, 30 days).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from kp.m01_platform import get_logger
from kp.m03_llm import LlmRequest, LlmResult, complete

from .models import MarketMetrics, Supplier, unsupported_numbers, why_hash, why_numbers, stable_json
from .store import MarketStore, StoredMarketRow, fta_by_agreement

_log = get_logger("kp.m14_markets.why")

WHY_PURPOSE = "m14.why_market"
WHY_MAX_CHARS = 600

WHY_SYSTEM = (
    "You write a short 'why this market' note for an Indian exporter looking at one importing country "
    "for one HS product code. You receive a JSON object of facts. Rules:\n"
    "- Use ONLY the facts in the JSON. Every number you write must appear in the JSON exactly as given "
    "(you may drop trailing zeros). Do not calculate, add, subtract, round differently, rank or estimate "
    "anything, and do not mention any other number, year or percentage.\n"
    "- import_value_usd_millions is the country's total imports of the code in data_year, in USD millions. "
    "cagr_5y_percent is the compound annual growth of those imports over cagr_years years. "
    "india_share_percent is India's share of those imports. top_suppliers are the largest supplying "
    "countries with their share_percent. fta names a trade agreement between India and the country, or is null.\n"
    "- Countries are ISO 3166-1 alpha-2 codes; write the country names in English.\n"
    "- Null values mean the fact is unknown: do not mention it.\n"
    "- Two sentences, at most 60 words, plain and factual, no advice, no hype.\n"
    'Reply with JSON only: {"text": "<the note>"}'
)

WHY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"text": {"type": "string", "minLength": 1, "maxLength": WHY_MAX_CHARS}},
    "required": ["text"],
    "additionalProperties": False,
}

LlmCall = Callable[[LlmRequest], LlmResult]
_llm: LlmCall = complete


def set_llm_for_testing(fn: LlmCall | None) -> None:
    global _llm
    _llm = fn or complete


@dataclass(frozen=True)
class WhyOutcome:
    status: str          # 'generated' | 'rejected' | 'up_to_date' | 'missing' | 'stale'
    text: str | None = None
    unsupported: tuple[float, ...] = ()


def numbers_for_row(row: StoredMarketRow, store: MarketStore) -> dict[str, Any]:
    m = MarketMetrics(
        country=row.country, code=row.code, data_year=row.data_year, import_value_usd=row.import_value_usd,
        cagr_5y=row.cagr_5y, india_share=row.india_share,
        top_suppliers=tuple(Supplier(str(s["country"]), float(s["share"])) for s in row.top_suppliers),
    )
    fta = fta_by_agreement(store.ftas(), row.country, row.fta_ref) if row.fta_ref else None
    return why_numbers(m, fta)


def check_why(text: str, numbers: dict[str, Any]) -> tuple[str | None, tuple[float, ...]]:
    """(accepted text or None, the numbers that were not in the input)."""
    t = " ".join(text.split())
    if not t or len(t) > WHY_MAX_CHARS:
        return None, ()
    bad = tuple(unsupported_numbers(t, numbers))
    return (None, bad) if bad else (t, ())


def generate_why(store: MarketStore, country: str, code: str, *, expected_hash: str | None = None,
                 correlation_id: str | None = None, force: bool = False) -> WhyOutcome:
    row = store.get_row(country, code)
    if row is None:
        return WhyOutcome("missing")
    if expected_hash is not None and row.why_input_hash != expected_hash:
        return WhyOutcome("stale")  # rebuilt since the job was enqueued; the new build enqueues again
    if row.why_text is not None and not force:
        return WhyOutcome("up_to_date", row.why_text)
    numbers = numbers_for_row(row, store)
    if why_hash(numbers) != row.why_input_hash:
        # Float round-trip at a rounding boundary: the text is still checked against the numbers the
        # row shows, and is written under the row's own hash.
        _log.warning("why input hash differs from the stored hash", extra={"country": country, "code": code})
    res = _llm(LlmRequest(
        tier="draft", purpose=WHY_PURPOSE, system=WHY_SYSTEM,
        messages=[{"role": "user", "content": stable_json(numbers)}],
        pii_free=True, json_schema=WHY_SCHEMA, temperature=0.2, cacheable=True,
        correlation_id=correlation_id, job_type="m14.generate_why",
    ))
    raw = res.json.get("text") if isinstance(res.json, dict) else None
    text, bad = check_why(raw if isinstance(raw, str) else "", numbers)
    if text is None:
        _log.info("why summary rejected by the number check",
                  extra={"country": country, "code": code, "unsupported": list(bad)[:10]})
        store.set_why(country, code, row.why_input_hash, None)
        return WhyOutcome("rejected", None, bad)
    if not store.set_why(country, code, row.why_input_hash, text):
        return WhyOutcome("stale")
    return WhyOutcome("generated", text)
