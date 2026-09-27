"""M19 deterministic logistics rules (LLD M19 steps 1 and 2).

Step 1 — curated list ``/config/logistics_entities.yaml`` (domains and normalised names):
    a hit → ``is_logistics`` with confidence 1.0.
    - domain: the company's domain equals a listed domain or is a sub-domain of it;
    - name: the normalised name equals a listed name, or (for listed names of two or more words)
      starts with it followed by further words ("kuehne nagel uk" ← "Kuehne + Nagel"). One-word
      names match exactly only, so "GAC" does not flag "GAC Foods".
Step 2 — keyword rules on the company name (freight, logistics, forwarding, shipping agency,
    customs broker, NVOCC …, plus common non-English equivalents) → confidence 0.85.
"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from unidecode import unidecode

from kp.m01_platform import KpError, get_logger
from kp.m18_resolution import normalise_domain, normalise_name

from .models import CURATED_CONFIDENCE, KEYWORD_CONFIDENCE

_log = get_logger("kp.m19_classifiers.rules")

_NON_ALNUM = re.compile(r"[^a-z0-9]+")

# Whole phrases matched on word boundaries of the folded name.
KEYWORD_PHRASES: tuple[str, ...] = (
    "freight", "freights", "freight forwarder", "freight forwarders", "freight forwarding",
    "forwarding", "forwarder", "forwarders", "forwarding agent", "forwarding agents",
    "shipping agency", "shipping agencies", "shipping agent", "shipping agents", "ship agency",
    "shipping and forwarding", "shipping line", "shipping lines", "container line", "container lines",
    "customs broker", "customs brokers", "customs brokerage", "customs clearance", "customs agent",
    "customs agents", "customs clearing", "clearing agent", "clearing agents", "clearing and forwarding",
    "c and f agent", "c and f agents", "custom house agent", "custom house agents",
    "nvocc", "3pl", "4pl", "third party logistics",
    "cargo", "air cargo", "sea cargo", "cargo services",
    "courier", "couriers", "express logistics",
    "transitaire", "transitaires", "transitario", "transitarios", "transitarias",
    "spedizioni", "spedizioniere", "expeditie", "expediteur", "expeditions internationales",
    "vervoer", "transporte internacional", "transportes internacionales",
    "despachante aduaneiro", "agente de aduanas", "agencia de aduanas", "commissionnaire en douane",
    "zollagentur",
)

# Word prefixes (catch inflections and German compounds such as "Logistikzentrum").
KEYWORD_PREFIXES: tuple[str, ...] = ("logisti", "logistik", "spedition", "speditions", "spediteur")

_PHRASE_RES: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (p, re.compile(r"(?:^| )" + re.escape(p) + r"(?: |$)")) for p in KEYWORD_PHRASES
)


def fold_name(name: str | None) -> str:
    """Lower-case, transliterated, punctuation-free form used for keyword rules ('&' → 'and')."""
    if not name or not isinstance(name, str):
        return ""
    s = unidecode(name).lower().replace("&", " and ").replace("+", " ")
    return " ".join(t for t in _NON_ALNUM.split(s) if t)


@dataclass(frozen=True)
class RuleHit:
    method: str          # 'curated' | 'keyword'
    rule: str            # e.g. 'domain:dhl.com', 'name:kuehne nagel', 'keyword:freight'
    confidence: float


@dataclass(frozen=True)
class CuratedList:
    domains: frozenset[str]
    names_exact: frozenset[str]
    names_prefix: tuple[str, ...]     # multi-word names allowed to match as a prefix
    version: int = 1

    @staticmethod
    def build(domains: Iterable[str], names: Iterable[str], version: int = 1) -> "CuratedList":
        ds: set[str] = set()
        for d in domains:
            nd = normalise_domain(d) if isinstance(d, str) else None
            if nd:
                ds.add(nd)
            elif isinstance(d, str) and d.strip():
                _log.warning("curated logistics domain could not be normalised; ignored", extra={"domain": d})
        exact: set[str] = set()
        prefix: set[str] = set()
        for n in names:
            if not isinstance(n, str):
                continue
            for form in {normalise_name(n), fold_name(n)}:
                if not form:
                    continue
                exact.add(form)
                if " " in form:
                    prefix.add(form)
        return CuratedList(domains=frozenset(ds), names_exact=frozenset(exact),
                           names_prefix=tuple(sorted(prefix, key=len, reverse=True)), version=version)

    def match_domain(self, domain: str | None) -> str | None:
        d = normalise_domain(domain) if domain else None
        if not d:
            return None
        labels = d.split(".")
        for i in range(len(labels) - 1):
            parent = ".".join(labels[i:])
            if parent in self.domains:
                return parent
        return None

    def match_name(self, name: str | None) -> str | None:
        if not name:
            return None
        for form in (normalise_name(name), fold_name(name)):
            if not form:
                continue
            if form in self.names_exact:
                return form
            for p in self.names_prefix:
                if form.startswith(p + " "):
                    return p
        return None


def parse_curated(doc: Any) -> CuratedList:
    if not isinstance(doc, Mapping):
        raise KpError("VALIDATION", "logistics_entities.yaml: expected a mapping with 'domains' and 'names'")
    domains = doc.get("domains") or []
    names = doc.get("names") or []
    if isinstance(domains, (str, bytes)) or not isinstance(domains, list):
        raise KpError("VALIDATION", "logistics_entities.yaml: 'domains' must be a list")
    if isinstance(names, (str, bytes)) or not isinstance(names, list):
        raise KpError("VALIDATION", "logistics_entities.yaml: 'names' must be a list")
    version = doc.get("version", 1)
    return CuratedList.build(domains, names, int(version) if isinstance(version, int) else 1)


def default_curated_path() -> Path:
    """<repo>/config/logistics_entities.yaml (py/kp/m19_classifiers/rules.py → parents[3] is the repo root)."""
    return Path(__file__).resolve().parents[3] / "config" / "logistics_entities.yaml"


_lock = threading.Lock()
_override: CuratedList | None = None
_cached: tuple[Path, float, CuratedList] | None = None


def set_curated_list_for_testing(lst: CuratedList | None) -> None:
    """Replaces the curated list (``None`` goes back to the config file)."""
    global _override, _cached
    with _lock:
        _override = lst
        _cached = None


def load_curated_list(path: str | Path | None = None) -> CuratedList:
    """Loads (and caches by mtime) the curated list. A missing file is an error, not an empty list."""
    import yaml

    global _cached
    with _lock:
        if _override is not None and path is None:
            return _override
    p = Path(path) if path is not None else default_curated_path()
    try:
        mtime = p.stat().st_mtime
    except FileNotFoundError as e:
        raise KpError("INTERNAL", f"Curated logistics list not found: {p}") from e
    with _lock:
        if _cached is not None and _cached[0] == p and _cached[1] == mtime:
            return _cached[2]
    lst = parse_curated(yaml.safe_load(p.read_text(encoding="utf-8")))
    with _lock:
        _cached = (p, mtime, lst)
    _log.info("curated logistics list loaded", extra={"domains": len(lst.domains), "names": len(lst.names_exact)})
    return lst


def curated_hit(name: str | None, domains: Iterable[str | None], lst: CuratedList | None = None) -> RuleHit | None:
    """Step 1."""
    cl = lst or load_curated_list()
    for d in domains:
        m = cl.match_domain(d)
        if m:
            return RuleHit("curated", f"domain:{m}", CURATED_CONFIDENCE)
    n = cl.match_name(name)
    if n:
        return RuleHit("curated", f"name:{n}", CURATED_CONFIDENCE)
    return None


def keyword_hit(name: str | None) -> RuleHit | None:
    """Step 2."""
    folded = fold_name(name)
    if not folded:
        return None
    for phrase, rx in _PHRASE_RES:
        if rx.search(folded):
            return RuleHit("keyword", f"keyword:{phrase}", KEYWORD_CONFIDENCE)
    for tok in folded.split(" "):
        for pre in KEYWORD_PREFIXES:
            if tok.startswith(pre):
                return RuleHit("keyword", f"keyword:{pre}*", KEYWORD_CONFIDENCE)
    return None


def rule_hit(name: str | None, domains: Iterable[str | None], lst: CuratedList | None = None) -> RuleHit | None:
    """Steps 1 then 2; ``None`` when neither applies (go to the LLM step)."""
    return curated_hit(name, list(domains), lst) or keyword_hit(name)
