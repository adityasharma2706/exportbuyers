"""Company-name normalisation and similarity for registry matching.

Similarity is computed on names with accents folded, punctuation removed and legal-form words
(Ltd, GmbH, S.A. …) dropped, so "ACME Trading Limited" and "Acme Trading Ltd." score 1.0.
"""
from __future__ import annotations

import re

from rapidfuzz import fuzz
from unidecode import unidecode

# Legal-form and filler tokens removed before comparison (lower-case, after punctuation removal).
LEGAL_FORMS: frozenset[str] = frozenset({
    "ltd", "limited", "plc", "llp", "lp", "llc", "inc", "incorporated", "corp", "corporation", "co",
    "company", "cie", "gmbh", "mbh", "ag", "kg", "kgaa", "ohg", "ug", "ev", "sa", "sas", "sarl", "sasu", "srl",
    "spa", "sl", "slu", "sau", "bv", "nv", "vof", "oy", "oyj", "ab", "as", "asa", "aps", "sro", "spzoo", "zoo",
    "kft", "zrt", "nyrt", "doo", "dd", "ooo", "oao", "zao", "pao", "pte", "pvt", "private", "pty", "bhd", "sdn",
    "tbk", "pt", "jsc", "ojsc", "cjsc", "lda", "ltda", "cv", "de", "the", "and", "und", "et", "y", "group",
    "holding", "holdings", "sae", "wll", "fze", "fzco", "fzc", "fzllc", "est", "kk", "gk", "yk",
})

# Multi-token legal forms collapsed before tokenising ("s.a.", "s.r.l.", "sp. z o.o.").
_COLLAPSE = [
    (re.compile(r"\bs\s*\.?\s*p\s*\.?\s*z\s*o\s*\.?\s*o\s*\.?"), " spzoo "),
    (re.compile(r"\b(?:[a-z]\.){2,}"), lambda m: " " + m.group(0).replace(".", "") + " "),
]
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalise_name(name: str) -> str:
    """Folded, lower-case name without legal forms. May be empty for names that are only a legal form."""
    s = unidecode(name or "").lower().replace("&", " and ")
    for rx, repl in _COLLAPSE:
        s = rx.sub(repl, s)  # type: ignore[arg-type]
    tokens = [t for t in _NON_ALNUM.split(s) if t]
    kept = [t for t in tokens if t not in LEGAL_FORMS]
    return " ".join(kept if kept else tokens)


def name_similarity(a: str, b: str) -> float:
    """0..1 similarity of two company names (token-sort ratio on normalised names)."""
    na, nb = normalise_name(a), normalise_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    return round(fuzz.token_sort_ratio(na, nb) / 100.0, 4)


def best_similarity(query: str, names: list[str] | tuple[str, ...]) -> float:
    return max((name_similarity(query, n) for n in names if n), default=0.0)
