"""M18 Normalisation and entity resolution — Python public API.

Enabling REQ-021 (one coherent profile per company) and REQ-037 (no resurrection of removed data);
REQ-064 (merge review items).

- IF-18a ``resolve(candidate, *, tx) -> Resolution``: suppression check → deterministic anchors
  (lei → registry → vat → domain; free-mail / marketplace domains excluded) → fuzzy match
  (trigram name similarity, city, address tokens) → new company.
- Merges below the match threshold, and conflicting anchors, become ``entity.merge_review`` items
  in M11 via the serving-plane job ``m18.file_merge_review``; the ``merge`` outcome is applied by
  M09 IF-09b ``merge_confirm`` (see ``apps/web/src/modules/m18_resolution``).

Other knowledge-plane modules (M20, M21, M22) import only from here.
"""
from .models import (
    MATCH_THRESHOLD,
    NAME_PREFILTER,
    REVIEW_THRESHOLD,
    Candidate,
    MatchKey,
    MergeReview,
    Resolution,
    ScoredMatch,
)
from .normalise import (
    DEFAULT_EXCLUDED_ANCHOR_DOMAINS,
    address_overlap,
    address_tokens,
    is_excluded_anchor_domain,
    normalise_city,
    normalise_domain,
    normalise_name,
    set_excluded_anchor_domains,
    trigram_similarity,
)
from .resolver import (
    ANCHOR_ORDER,
    FILE_MERGE_REVIEW_JOB,
    MERGE_REVIEW_TYPE,
    Prepared,
    counters,
    prepare,
    resolve,
    score,
)
from .store import MatchStore, MemoryMatchStore, MemoryOutbox, Outbox, PgMatchStore, PgOutbox, memory_backends

__all__ = [
    "ANCHOR_ORDER",
    "DEFAULT_EXCLUDED_ANCHOR_DOMAINS",
    "FILE_MERGE_REVIEW_JOB",
    "MATCH_THRESHOLD",
    "MERGE_REVIEW_TYPE",
    "NAME_PREFILTER",
    "REVIEW_THRESHOLD",
    "Candidate",
    "MatchKey",
    "MatchStore",
    "MemoryMatchStore",
    "MemoryOutbox",
    "MergeReview",
    "Outbox",
    "PgMatchStore",
    "PgOutbox",
    "Prepared",
    "Resolution",
    "ScoredMatch",
    "address_overlap",
    "address_tokens",
    "counters",
    "is_excluded_anchor_domain",
    "memory_backends",
    "normalise_city",
    "normalise_domain",
    "normalise_name",
    "prepare",
    "resolve",
    "score",
    "set_excluded_anchor_domains",
    "trigram_similarity",
]
