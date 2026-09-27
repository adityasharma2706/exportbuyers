"""M19 LLM step (LLD M19 step 3).

Tier ``classify``, ``pii_free``. The model sees only the company's name/country and the evidence
snippets, each labelled ``E1``…``En``; it must cite the labels it relied on. Labels are mapped back
to evidence assertion ids here. A result without a valid citation becomes ``unknown`` (and not
logistics).

Snippets are redacted of e-mail addresses and phone numbers before sending (the request is
declared ``pii_free`` and M03 refuses it otherwise); a snippet that still trips the M03 PII
detector after redaction is left out.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence
from uuid import UUID

from kp.m01_platform import get_logger
from kp.m03_llm import LlmRequest, LlmResult, complete, detect_pii

from .models import BUYER_TYPES, MAX_SNIPPET_CHARS, MAX_SNIPPETS, EvidenceText

_log = get_logger("kp.m19_classifiers.llm")

PURPOSE = "m19.classify_buyer"

LlmFn = Callable[[LlmRequest], LlmResult]

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
# Broad: any run of 7+ digits possibly separated by spaces, dots, dashes, slashes or brackets.
_PHONE_RE = re.compile(r"(?:\+|\b00)?\(?\d[\d\s().\-/]{5,24}\d")

SYSTEM_PROMPT = (
    "You classify companies for an export-buyer database. Use ONLY the evidence snippets provided; "
    "do not use outside knowledge about the company.\n"
    "Decide two things:\n"
    "1. is_logistics: true if the company is a logistics intermediary rather than a buyer of goods "
    "(freight forwarder, shipping line or agency, customs broker, NVOCC, courier, warehouse/3PL "
    "provider).\n"
    "2. buyer_type: the company's main role as a buyer of goods: 'importer' (imports goods itself), "
    "'distributor' (distributes brands/products to other businesses), 'wholesaler' (sells in bulk to "
    "retailers/trade), 'retailer' (sells to consumers, shops or e-commerce), 'manufacturer' (makes "
    "products and buys inputs), or 'unknown' when the snippets do not say.\n"
    "Give each a confidence between 0 and 1. List in 'citations' the labels (E1, E2, …) of the "
    "snippets that support your answer. If no snippet supports an answer, return buyer_type "
    "'unknown', is_logistics false and an empty citations list.\n"
    "Reply with a single JSON object only."
)

JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["is_logistics", "logistics_confidence", "buyer_type", "type_confidence", "citations"],
    "properties": {
        "is_logistics": {"type": "boolean"},
        "logistics_confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "buyer_type": {"type": "string", "enum": list(BUYER_TYPES)},
        "type_confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "citations": {"type": "array", "maxItems": MAX_SNIPPETS,
                      "items": {"type": "string", "pattern": "^E[0-9]{1,3}$"}},
    },
}


def redact(text: str) -> str:
    """Removes e-mail addresses and phone-like digit runs."""
    out = _EMAIL_RE.sub("[email]", text)

    def _phone(m: re.Match[str]) -> str:
        digits = sum(ch.isdigit() for ch in m.group(0))
        return "[phone]" if digits >= 7 else m.group(0)

    return _PHONE_RE.sub(_phone, out)


@dataclass
class Prompt:
    user: str
    labels: dict[str, UUID] = field(default_factory=dict)   # 'E1' → evidence assertion id
    dropped: int = 0


def build_prompt(name: str, country: str | None, evidence: Sequence[EvidenceText]) -> Prompt:
    """Deduplicates evidence (by assertion id and by text), redacts and labels it."""
    safe_name = redact(name or "")
    if detect_pii(safe_name):
        safe_name = "(name withheld)"
    labels: dict[str, UUID] = {}
    lines: list[str] = []
    seen_ids: set[UUID] = set()
    seen_texts: set[str] = set()
    dropped = 0
    for ev in evidence:
        if len(labels) >= MAX_SNIPPETS:
            dropped += 1
            continue
        if ev.assertion_id in seen_ids:
            continue
        text = " ".join(redact(ev.text).split())[:MAX_SNIPPET_CHARS]
        key = text.lower()
        if not text or key in seen_texts:
            continue
        if detect_pii(text):
            dropped += 1
            _log.info("evidence snippet left out of LLM prompt: PII pattern after redaction",
                      extra={"assertion_id": str(ev.assertion_id)})
            continue
        seen_ids.add(ev.assertion_id)
        seen_texts.add(key)
        label = f"E{len(labels) + 1}"
        labels[label] = ev.assertion_id
        heading = f" [HS {ev.hs_heading}]" if ev.hs_heading else ""
        lines.append(f"{label}{heading}: {json.dumps(text, ensure_ascii=False)}")
    user = (f"Company: {json.dumps(safe_name, ensure_ascii=False)}\n"
            f"Country: {country or 'unknown'}\n"
            "Evidence snippets:\n" + "\n".join(lines))
    return Prompt(user=user, labels=labels, dropped=dropped)


@dataclass(frozen=True)
class LlmVerdict:
    is_logistics: bool
    logistics_confidence: float
    buyer_type: str
    type_confidence: float
    cited: tuple[UUID, ...]
    model: str | None = None


def _clamp(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if f != f else max(0.0, min(1.0, f))   # NaN → 0


UNKNOWN = LlmVerdict(is_logistics=False, logistics_confidence=0.0, buyer_type="unknown", type_confidence=0.0, cited=())


def interpret(parsed: Any, labels: dict[str, UUID], model: str | None = None) -> LlmVerdict:
    """Maps the model output onto a verdict; no valid citation → ``unknown``."""
    if not isinstance(parsed, dict):
        return UNKNOWN
    cited: list[UUID] = []
    for c in parsed.get("citations") or []:
        if isinstance(c, str) and c.strip().upper() in labels:
            aid = labels[c.strip().upper()]
            if aid not in cited:
                cited.append(aid)
    if not cited:
        return LlmVerdict(False, 0.0, "unknown", 0.0, (), model)
    is_log = parsed.get("is_logistics") is True
    btype = parsed.get("buyer_type")
    btype = btype if isinstance(btype, str) and btype in BUYER_TYPES else "unknown"
    t_conf = _clamp(parsed.get("type_confidence")) if btype != "unknown" else 0.0
    if is_log:
        # A logistics intermediary is not a buyer; its "type" is not meaningful for buyer filters.
        btype, t_conf = "unknown", 0.0
    l_conf = _clamp(parsed.get("logistics_confidence"))
    return LlmVerdict(is_logistics=is_log, logistics_confidence=l_conf, buyer_type=btype,
                      type_confidence=t_conf, cited=tuple(cited), model=model)


def llm_classify(name: str, country: str | None, evidence: Sequence[EvidenceText], *,
                 llm: LlmFn | None = None, correlation_id: str | None = None,
                 job_type: str | None = None) -> LlmVerdict:
    """Step 3. Raises the M03 errors (UPSTREAM_UNAVAILABLE, LLM_BAD_OUTPUT) so a job can retry."""
    prompt = build_prompt(name, country, evidence)
    if not prompt.labels:
        return UNKNOWN
    req = LlmRequest(tier="classify", purpose=PURPOSE, system=SYSTEM_PROMPT,
                     messages=[{"role": "user", "content": prompt.user}], pii_free=True,
                     json_schema=JSON_SCHEMA, temperature=0, cacheable=True,
                     correlation_id=correlation_id, job_type=job_type)
    res = (llm or complete)(req)
    verdict = interpret(res.json, prompt.labels, res.model)
    _log.info("m19 llm classification", extra={"buyer_type": verdict.buyer_type, "is_logistics": verdict.is_logistics,
                                               "cited": len(verdict.cited), "snippets": len(prompt.labels),
                                               "dropped": prompt.dropped, "cached": res.cached})
    return verdict
