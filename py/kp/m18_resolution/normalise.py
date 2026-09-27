"""M18 normalisation helpers.

- Names: the M17 function (``normalise_name``), as the LLD requires ("same function as M17").
- Domains: the M10 spec (``kp.m10_policy.normalise('domain', …)``: registrable domain via the PSL).
- City / address: transliterated, lower-cased, punctuation collapsed; address tokens drop common
  street-type words and very short tokens so the overlap measures the distinctive parts.
- ``trigram_similarity`` reproduces PostgreSQL pg_trgm ``similarity()`` so the in-memory store and
  the Pg prefilter agree on what "> 0.5" means.
- Free-mail and marketplace domains are never used as anchors (LLD M18 step 3).
"""
from __future__ import annotations

import re
import threading
import unicodedata
from functools import lru_cache
from typing import Iterable

from unidecode import unidecode

from kp.m01_platform import KpError, get_logger
from kp.m10_policy import normalise as m10_normalise
from kp.m17_sanctions import normalise_name

_log = get_logger("kp.m18_resolution.normalise")

__all__ = [
    "DEFAULT_EXCLUDED_ANCHOR_DOMAINS",
    "address_overlap",
    "address_tokens",
    "is_excluded_anchor_domain",
    "normalise_city",
    "normalise_domain",
    "normalise_name",
    "set_excluded_anchor_domains",
    "trigram_similarity",
    "trigrams",
]

_NON_ALNUM = re.compile(r"[^a-z0-9]+")

# Free-mail providers and marketplace / platform hosts: many unrelated companies share them, so they
# can never identify a company [tunable: set_excluded_anchor_domains].
DEFAULT_EXCLUDED_ANCHOR_DOMAINS: frozenset[str] = frozenset({
    # free mail
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "yahoo.fr", "yahoo.de", "ymail.com",
    "rocketmail.com", "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "outlook.com", "live.com",
    "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "protonmail.com", "proton.me", "gmx.com", "gmx.de",
    "gmx.net", "web.de", "t-online.de", "mail.com", "mail.ru", "yandex.ru", "yandex.com", "zoho.com",
    "zohomail.com", "qq.com", "163.com", "126.com", "sina.com", "rediffmail.com", "libero.it", "orange.fr",
    "free.fr", "laposte.net", "wanadoo.fr", "btinternet.com", "sky.com", "comcast.net", "verizon.net",
    "att.net", "tutanota.com", "fastmail.com", "hushmail.com", "inbox.com", "naver.com", "daum.net",
    # marketplaces, directories and platforms
    "alibaba.com", "aliexpress.com", "1688.com", "made-in-china.com", "globalsources.com", "dhgate.com",
    "indiamart.com", "tradeindia.com", "exportersindia.com", "amazon.com", "amazon.co.uk", "amazon.de",
    "amazon.in", "amazon.ae", "amazon.fr", "amazon.nl", "ebay.com", "ebay.co.uk", "ebay.de", "etsy.com",
    "walmart.com", "noon.com", "flipkart.com", "rakuten.com", "tradekey.com", "ec21.com", "ecplaza.net",
    "europages.com", "kompass.com", "yellowpages.com", "yell.com", "thomasnet.com", "facebook.com", "fb.com",
    "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "wa.me", "whatsapp.com",
    "google.com", "sites.google.com", "blogspot.com", "wordpress.com", "wixsite.com", "weebly.com",
    "shopify.com", "bit.ly", "linktr.ee",
})

_excluded_lock = threading.Lock()
_excluded: frozenset[str] = DEFAULT_EXCLUDED_ANCHOR_DOMAINS


def set_excluded_anchor_domains(domains: Iterable[str] | None) -> None:
    """Replaces the free-mail / marketplace exclusion list (``None`` restores the default)."""
    global _excluded
    with _excluded_lock:
        if domains is None:
            _excluded = DEFAULT_EXCLUDED_ANCHOR_DOMAINS
        else:
            _excluded = frozenset(d.strip().lower().rstrip(".") for d in domains if d and d.strip())


def is_excluded_anchor_domain(domain_norm: str) -> bool:
    """True when the (normalised) domain, or a parent of it, is a free-mail or marketplace domain."""
    d = (domain_norm or "").strip().lower().rstrip(".")
    if not d:
        return True
    excluded = _excluded
    labels = d.split(".")
    return any(".".join(labels[i:]) in excluded for i in range(len(labels) - 1))


def normalise_domain(raw: str | None) -> str | None:
    """M10 domain normalisation; ``None`` for blank or unparseable input."""
    if raw is None or not isinstance(raw, str) or not raw.strip():
        return None
    try:
        d = m10_normalise("domain", raw)
    except KpError:
        _log.info("domain could not be normalised; ignored for resolution")
        return None
    return d or None


def _fold(s: str) -> str:
    decomposed = unicodedata.normalize("NFKD", s)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return unidecode(stripped).lower()


def _words(s: str | None) -> list[str]:
    if not s or not isinstance(s, str):
        return []
    return [t for t in _NON_ALNUM.split(_fold(s).replace("&", " and ")) if t]


def normalise_city(city: str | None) -> str | None:
    """Folded, punctuation-free city name (``None`` when blank)."""
    words = _words(city)
    if not words:
        return None
    # "St. Petersburg" / "Saint Petersburg", "Ft" / "Fort" read the same.
    alias = {"st": "saint", "ste": "sainte", "ft": "fort", "mt": "mount"}
    return " ".join(alias.get(w, w) for w in words)


# Street-type and filler words that carry no identity in an address.
_ADDRESS_STOPWORDS: frozenset[str] = frozenset({
    "street", "st", "road", "rd", "avenue", "ave", "av", "lane", "ln", "drive", "dr", "boulevard", "blvd",
    "way", "place", "pl", "court", "ct", "square", "sq", "floor", "fl", "flr", "suite", "ste", "unit",
    "building", "bldg", "block", "blk", "no", "number", "nr", "po", "box", "pobox", "the", "and", "of",
    "strasse", "str", "rue", "via", "calle", "straat", "weg", "office", "room", "rm", "level", "lvl",
    "near", "opp", "opposite", "area", "district", "industrial", "estate", "zone", "plot",
})


def address_tokens(address: str | None) -> frozenset[str]:
    """Distinctive address tokens: folded words minus street-type words; digits kept, 1-char words dropped."""
    out: set[str] = set()
    for w in _words(address):
        if w in _ADDRESS_STOPWORDS:
            continue
        if len(w) < 2 and not w.isdigit():
            continue
        out.add(w)
    return frozenset(out)


def address_overlap(a: Iterable[str] | None, b: Iterable[str] | None) -> float:
    """Jaccard overlap of two token sets (0.0 when either side is empty)."""
    sa, sb = frozenset(a or ()), frozenset(b or ())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


@lru_cache(maxsize=200_000)
def trigrams(s: str) -> frozenset[str]:
    """pg_trgm trigram set: words of alphanumerics, lower-cased, each padded '  word ' ."""
    out: set[str] = set()
    for word in _NON_ALNUM.split((s or "").lower()):
        if not word:
            continue
        padded = f"  {word} "
        for i in range(len(padded) - 2):
            out.add(padded[i:i + 3])
    return frozenset(out)


def trigram_similarity(a: str, b: str) -> float:
    """Equivalent of pg_trgm ``similarity(a, b)``: |A ∩ B| / |A ∪ B| over trigram sets."""
    ta, tb = trigrams(a or ""), trigrams(b or "")
    if not ta or not tb:
        return 0.0
    union = len(ta | tb)
    return len(ta & tb) / union if union else 0.0
