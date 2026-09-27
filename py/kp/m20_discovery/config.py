"""M20 configuration: query building, domain block list, pre-warm plan and the released-country list.

Files (repo root ``/config``):
- ``discovery.yaml``           query templates per language, synonyms, block lists, limits [tunable]
- ``prewarm.yaml``             weekly pre-warm plan: countries × top headings [tunable]
- ``discovery_released.yaml``  countries whose web-found rows may be served (precision bar, HLD OQ9)
"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import yaml

from kp.m01_platform import KpError

_CC_RE = re.compile(r"^[A-Z]{2}$")
_HEADING_RE = re.compile(r"^\d{4}$")
_LANG_RE = re.compile(r"^[a-z]{2}$")


def config_dir() -> Path:
    """<repo>/config (py/kp/m20_discovery/config.py → parents[3] is the repo root)."""
    return Path(__file__).resolve().parents[3] / "config"


def _load_yaml(path: Path) -> Mapping[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
    except FileNotFoundError as e:
        raise KpError("INTERNAL", f"M20 config file is missing: {path}") from e
    except yaml.YAMLError as e:
        raise KpError("INTERNAL", f"M20 config file is not valid YAML: {path}") from e
    if data is None:
        return {}
    if not isinstance(data, Mapping):
        raise KpError("INTERNAL", f"M20 config file must be a mapping: {path}")
    return data


def _cc(v: Any, where: str) -> str:
    c = str(v).strip().upper()
    if not _CC_RE.match(c):
        raise KpError("INTERNAL", f"{where}: {v!r} is not an ISO 3166-1 alpha-2 code")
    return c


def _heading(v: Any, where: str) -> str:
    h = str(v).strip()
    if not _HEADING_RE.match(h):
        raise KpError("INTERNAL", f"{where}: {v!r} is not a 4-digit HS heading")
    return h


def _pos_int(d: Mapping[str, Any], key: str, default: int) -> int:
    v = d.get(key, default)
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        raise KpError("INTERNAL", f"discovery.yaml: {key} must be a positive integer")
    return v


# ---- discovery.yaml -------------------------------------------------------------------------------

@dataclass(frozen=True)
class DiscoveryConfig:
    country_languages: Mapping[str, tuple[str, ...]]
    default_languages: tuple[str, ...]
    country_names: Mapping[str, Mapping[str, str]]
    query_templates: Mapping[str, tuple[str, ...]]
    synonyms: Mapping[str, Mapping[str, tuple[str, ...]]]
    blocked_domains: frozenset[str]
    max_results_per_query: int = 30
    max_domains_per_run: int = 60
    max_internal_pages: int = 5
    max_page_chars_for_llm: int = 8000
    max_total_chars_for_llm: int = 24000

    def languages_for(self, country: str) -> tuple[str, ...]:
        return self.country_languages.get(country.upper(), self.default_languages)

    def country_name(self, country: str, lang: str) -> str:
        c = country.upper()
        return self.country_names.get(lang, {}).get(c) or self.country_names.get("en", {}).get(c) or c

    def synonyms_for(self, heading: str, lang: str) -> tuple[str, ...]:
        return self.synonyms.get(heading, {}).get(lang, ())

    def is_blocked(self, registrable_domain: str) -> bool:
        d = registrable_domain.lower().strip(".")
        parts = d.split(".")
        return any(".".join(parts[i:]) in self.blocked_domains for i in range(len(parts) - 1))


def parse_discovery_config(data: Mapping[str, Any]) -> DiscoveryConfig:
    langs: dict[str, tuple[str, ...]] = {}
    for c, ls in (data.get("country_languages") or {}).items():
        if not isinstance(ls, list) or not ls:
            raise KpError("INTERNAL", f"discovery.yaml: country_languages.{c} must be a non-empty list")
        langs[_cc(c, "discovery.yaml country_languages")] = tuple(str(x).lower() for x in ls)
    default_langs = tuple(str(x).lower() for x in (data.get("default_languages") or ["en"]))

    templates: dict[str, tuple[str, ...]] = {}
    for lang, ts in (data.get("query_templates") or {}).items():
        if not _LANG_RE.match(str(lang)):
            raise KpError("INTERNAL", f"discovery.yaml: bad language code {lang!r}")
        if not isinstance(ts, list) or not ts:
            raise KpError("INTERNAL", f"discovery.yaml: query_templates.{lang} must be a non-empty list")
        for t in ts:
            if not isinstance(t, str) or "{term}" not in t:
                raise KpError("INTERNAL", f"discovery.yaml: template {t!r} must contain {{term}}")
        templates[str(lang)] = tuple(ts)
    for lang in {*default_langs, *(x for ls in langs.values() for x in ls)}:
        if lang not in templates:
            raise KpError("INTERNAL", f"discovery.yaml: no query_templates for language {lang!r}")

    names: dict[str, dict[str, str]] = {}
    for lang, m in (data.get("country_names") or {}).items():
        names[str(lang)] = {_cc(c, "discovery.yaml country_names"): str(n) for c, n in (m or {}).items()}

    syn: dict[str, dict[str, tuple[str, ...]]] = {}
    for h, per_lang in (data.get("synonyms") or {}).items():
        hh = _heading(h, "discovery.yaml synonyms")
        syn[hh] = {str(lang): tuple(str(s).strip() for s in (terms or []) if str(s).strip())
                   for lang, terms in (per_lang or {}).items()}

    blocked: set[str] = set()
    raw_blocked = data.get("blocked_domains") or {}
    groups = raw_blocked.values() if isinstance(raw_blocked, Mapping) else [raw_blocked]
    for g in groups:
        for d in g or []:
            blocked.add(str(d).strip().lower().strip("."))

    return DiscoveryConfig(
        country_languages=langs,
        default_languages=default_langs,
        country_names=names,
        query_templates=templates,
        synonyms=syn,
        blocked_domains=frozenset(blocked),
        max_results_per_query=min(_pos_int(data, "max_results_per_query", 30), 30),
        max_domains_per_run=_pos_int(data, "max_domains_per_run", 60),
        max_internal_pages=min(_pos_int(data, "max_internal_pages", 5), 5),
        max_page_chars_for_llm=_pos_int(data, "max_page_chars_for_llm", 8000),
        max_total_chars_for_llm=_pos_int(data, "max_total_chars_for_llm", 24000),
    )


# ---- prewarm.yaml ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class PrewarmPlan:
    cron: str
    countries: tuple[str, ...]
    headings: tuple[str, ...]
    spread_hours: int = 24

    def cells(self) -> list[tuple[str, str]]:
        return [(c, h) for c in self.countries for h in self.headings]


def parse_prewarm(data: Mapping[str, Any]) -> PrewarmPlan:
    cron = str(data.get("cron") or "0 1 * * 0")
    countries = tuple(dict.fromkeys(_cc(c, "prewarm.yaml countries") for c in data.get("countries") or []))
    headings = tuple(dict.fromkeys(_heading(h, "prewarm.yaml headings") for h in data.get("headings") or []))
    if not countries or not headings:
        raise KpError("INTERNAL", "prewarm.yaml must list at least one country and one heading")
    spread = data.get("spread_hours", 24)
    if not isinstance(spread, int) or isinstance(spread, bool) or not 0 <= spread <= 168:
        raise KpError("INTERNAL", "prewarm.yaml: spread_hours must be an integer in 0..168")
    return PrewarmPlan(cron=cron, countries=countries, headings=headings, spread_hours=spread)


# ---- discovery_released.yaml ----------------------------------------------------------------------

@dataclass(frozen=True)
class ReleasedEntry:
    country: str
    discovery_version: int
    precision: float


@dataclass(frozen=True)
class ReleasedCountries:
    min_precision: float
    entries: tuple[ReleasedEntry, ...] = field(default_factory=tuple)

    def is_released(self, country: str, discovery_version: int | None = None) -> bool:
        c = country.strip().upper()
        for e in self.entries:
            if e.country != c or e.precision < self.min_precision:
                continue
            if discovery_version is None or e.discovery_version == discovery_version:
                return True
        return False


def parse_released(data: Mapping[str, Any]) -> ReleasedCountries:
    min_p = float(data.get("min_precision", 0.8))
    entries: list[ReleasedEntry] = []
    for i, e in enumerate(data.get("released") or []):
        if not isinstance(e, Mapping):
            raise KpError("INTERNAL", f"discovery_released.yaml: released[{i}] must be a mapping")
        entries.append(ReleasedEntry(
            country=_cc(e.get("country"), "discovery_released.yaml"),
            discovery_version=int(e.get("discovery_version", 1)),
            precision=float(e.get("precision", 0.0)),
        ))
    return ReleasedCountries(min_precision=min_p, entries=tuple(entries))


# ---- cached loaders -------------------------------------------------------------------------------

_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}
_overrides: dict[str, Any] = {}


def _cached(name: str, parse: Any) -> Any:
    with _lock:
        if name in _overrides:
            return _overrides[name]
    path = config_dir() / name
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError as e:
        raise KpError("INTERNAL", f"M20 config file is missing: {path}") from e
    with _lock:
        hit = _cache.get(name)
        if hit is not None and hit[0] == mtime:
            return hit[1]
    value = parse(_load_yaml(path))
    with _lock:
        _cache[name] = (mtime, value)
    return value


def get_discovery_config() -> DiscoveryConfig:
    return _cached("discovery.yaml", parse_discovery_config)  # type: ignore[no-any-return]


def get_prewarm_plan() -> PrewarmPlan:
    return _cached("prewarm.yaml", parse_prewarm)  # type: ignore[no-any-return]


def get_released_countries() -> ReleasedCountries:
    return _cached("discovery_released.yaml", parse_released)  # type: ignore[no-any-return]


def is_country_released(country: str, discovery_version: int | None = None) -> bool:
    """HLD OQ9: may web-found rows for ``country`` be served? (M26 reads this.)"""
    return get_released_countries().is_released(country, discovery_version)


def set_config_for_testing(*, discovery: DiscoveryConfig | None = None, prewarm: PrewarmPlan | None = None,
                           released: ReleasedCountries | None = None, reset: bool = False) -> None:
    with _lock:
        if reset:
            _overrides.clear()
            _cache.clear()
        if discovery is not None:
            _overrides["discovery.yaml"] = discovery
        if prewarm is not None:
            _overrides["prewarm.yaml"] = prewarm
        if released is not None:
            _overrides["discovery_released.yaml"] = released
