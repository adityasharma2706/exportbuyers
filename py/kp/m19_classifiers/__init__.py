"""M19 Buyer classifiers — non-buyer (logistics) filter and buyer type (Python public API).

REQ-020 (logistics entities are flagged and hidden via M10, not deleted), REQ-016 (buyer type),
REQ-018 (buyer-type filter data).

- IF-19a ``classify(company_id, evidence_texts, *, tx) -> Classification``: curated list
  (``/config/logistics_entities.yaml``) → keyword rules → LLM over the evidence snippets (must cite
  evidence assertion ids; uncited → ``unknown``). Writes ``logistics_flag`` / ``buyer_type``
  assertions with ``source_id='operator.classifier'``.

Other knowledge-plane modules (M20, M21, M22) import only from here.
"""
from .classifier import classify, counters
from .llm import JSON_SCHEMA, PURPOSE, SYSTEM_PROMPT, LlmVerdict, build_prompt, interpret, llm_classify, redact
from .models import (
    BUYER_TYPES,
    CLASSIFIER_SOURCE_ID,
    CURATED_CONFIDENCE,
    KEYWORD_CONFIDENCE,
    KNOWN_BUYER_TYPES,
    BuyerType,
    Classification,
    EvidenceText,
)
from .rules import (
    KEYWORD_PHRASES,
    CuratedList,
    RuleHit,
    curated_hit,
    default_curated_path,
    fold_name,
    keyword_hit,
    load_curated_list,
    parse_curated,
    rule_hit,
    set_curated_list_for_testing,
)

__all__ = [
    "BUYER_TYPES",
    "CLASSIFIER_SOURCE_ID",
    "CURATED_CONFIDENCE",
    "JSON_SCHEMA",
    "KEYWORD_CONFIDENCE",
    "KEYWORD_PHRASES",
    "KNOWN_BUYER_TYPES",
    "PURPOSE",
    "SYSTEM_PROMPT",
    "BuyerType",
    "Classification",
    "CuratedList",
    "EvidenceText",
    "LlmVerdict",
    "RuleHit",
    "build_prompt",
    "classify",
    "counters",
    "curated_hit",
    "default_curated_path",
    "fold_name",
    "interpret",
    "keyword_hit",
    "llm_classify",
    "load_curated_list",
    "parse_curated",
    "redact",
    "rule_hit",
    "set_curated_list_for_testing",
]
