"""M17 name normalisation (shared with M18 entity resolution: "same function as M17").

    names_norm = NFKD → ASCII transliteration (unidecode) → lowercase → legal suffixes stripped
                 → punctuation collapsed

Dotted abbreviations are joined before the suffix check so "S.A.R.L." and "L.L.C." are recognised,
"&" reads as "and", and multi-word legal forms ("sdn bhd", "co ltd", "sp z o o") are stripped as a
unit. Suffixes are stripped from the end of the name only (repeatedly: "Foo Trading Co. Ltd." →
"foo trading"), so a legal-form word inside a name is kept. A name that would become empty keeps
its unstripped form.
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

from unidecode import unidecode

# Single-token legal forms (after dots are joined and the text is lowercased).
LEGAL_SUFFIXES: frozenset[str] = frozenset({
    "ltd", "limited", "llc", "lc", "llp", "lp", "plc", "inc", "incorporated", "corp", "corporation",
    "co", "cos", "company", "companies", "gmbh", "mbh", "ag", "kg", "kgaa", "ohg", "ug", "ev",
    "bv", "nv", "vof", "sarl", "sa", "sas", "sasu", "sca", "scs", "snc", "eurl", "srl", "spa", "sapa",
    "sl", "slu", "ltda", "cia", "eireli", "epp", "sab",
    "fze", "fzco", "fzc", "fzllc", "dmcc", "wll", "spc", "pjsc", "psc", "jsc", "ojsc", "cjsc", "pao", "oao",
    "zao", "ooo", "tov", "pat", "prat", "ao", "tdv",
    "pvt", "private", "pte", "pty", "bhd", "sdn", "tbk", "kk", "yk", "gk",
    "oy", "oyj", "ab", "publ", "as", "asa", "aps", "hf", "ehf", "sro", "spol", "kft", "zrt", "nyrt",
    "doo", "dd", "ad", "ead", "eood", "ood", "zoo", "ska", "sia", "uab", "ou",
    "shpk", "est", "establishment",
})

# Multi-token legal forms, longest first so "co ltd" wins over "ltd".
_MULTI_SUFFIXES: tuple[tuple[str, ...], ...] = tuple(sorted({
    ("co", "ltd"), ("co", "limited"), ("pvt", "ltd"), ("private", "limited"), ("pte", "ltd"),
    ("pty", "ltd"), ("sdn", "bhd"), ("sp", "z", "o", "o"), ("s", "de", "rl"), ("s", "de", "rl", "de", "cv"),
    ("sa", "de", "cv"), ("s", "a"), ("s", "l"), ("b", "v"), ("n", "v"), ("l", "l", "c"), ("fz", "llc"),
    ("fz", "co"), ("free", "zone", "establishment"), ("free", "zone", "company"), ("joint", "stock", "company"),
    ("public", "joint", "stock", "company"), ("closed", "joint", "stock", "company"),
    ("open", "joint", "stock", "company"), ("limited", "liability", "company"),
    ("limited", "liability", "partnership"), ("public", "limited", "company"), ("and", "co"), ("and", "company"),
    ("et", "cie"), ("spol", "s", "r", "o"), ("s", "r", "o"), ("a", "s"), ("d", "o", "o"), ("z", "o", "o"),
}, key=len, reverse=True))

_LEADING_ARTICLES: frozenset[str] = frozenset({"the"})
_LEADING_LEGAL_FORMS: frozenset[str] = frozenset({
    "ooo", "oao", "zao", "pao", "ao", "tov", "pat", "prat", "pjsc", "ojsc", "cjsc", "jsc", "pt", "cv", "tdv",
})

_DOTTED_ABBREV = re.compile(r"\b(?:[a-z]\.){2,}[a-z]?\.?")   # s.a.r.l.  l.l.c  b.v.
_APOSTROPHES = re.compile(r"['`’‘]")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _transliterate(s: str) -> str:
    decomposed = unicodedata.normalize("NFKD", s)
    # Drop combining marks first (é → e); unidecode then transliterates the remaining scripts
    # (Cyrillic, Arabic, Greek, CJK, …) to ASCII.
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return unidecode(stripped)


def _tokens(s: str) -> list[str]:
    s = s.lower()
    s = _APOSTROPHES.sub("", s)
    s = s.replace("&", " and ").replace("+", " and ")
    s = _DOTTED_ABBREV.sub(lambda m: m.group(0).replace(".", ""), s)
    s = s.replace(".", "")  # "co." → "co", "inc." → "inc"
    return [t for t in _NON_ALNUM.split(s) if t]


def _strip_suffixes(tokens: list[str]) -> list[str]:
    out = list(tokens)
    while len(out) > 1 and out[0] in _LEADING_ARTICLES:
        out = out[1:]
    # Legal forms written before the name ("OOO Romashka", "PT Maju", "TOV Zirka").
    while len(out) > 1 and out[0] in _LEADING_LEGAL_FORMS:
        out = out[1:]
    changed = True
    while changed and len(out) > 1:
        changed = False
        for suf in _MULTI_SUFFIXES:
            n = len(suf)
            if len(out) > n and tuple(out[-n:]) == suf:
                out = out[:-n]
                changed = True
                break
        if not changed and len(out) > 1 and out[-1] in LEGAL_SUFFIXES:
            out = out[:-1]
            changed = True
    return out


@lru_cache(maxsize=100_000)
def normalise_name(name: str) -> str:
    """The M17/M18 normalised form of a company or person name ('' for blank input)."""
    if not isinstance(name, str):
        return ""
    tokens = _tokens(_transliterate(name))
    if not tokens:
        return ""
    stripped = _strip_suffixes(tokens)
    return " ".join(stripped or tokens)


def normalise_names(names: list[str] | tuple[str, ...]) -> list[str]:
    """Normalised, de-duplicated (order kept), non-empty forms of ``names``."""
    out: list[str] = []
    for n in names:
        v = normalise_name(n)
        if v and v not in out:
            out.append(v)
    return out
