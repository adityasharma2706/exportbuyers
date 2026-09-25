"""M12 HS nomenclature — row models and pure validation (no I/O).

Versions are ``<family><yyyy>``: ``HS2022`` / ``HS2027`` (WCO chapters, headings, subheadings) and
``ITCHS2022`` (DGFT national 8-digit lines). An ITC-HS version's 6-digit parents live in the HS
version of the same year.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable, Literal, Mapping, Sequence

from kp.m01_platform import KpError

HsLevel = Literal["chapter", "heading", "subheading", "national8"]
ExportPolicy = Literal["free", "restricted", "prohibited", "ste"]
Relation = Literal["1:1", "1:n", "n:1", "n:n"]

HS_LEVELS: tuple[str, ...] = ("chapter", "heading", "subheading", "national8")
EXPORT_POLICIES: tuple[str, ...] = ("free", "restricted", "prohibited", "ste")
RELATIONS: tuple[str, ...] = ("1:1", "1:n", "n:1", "n:n")
LEVEL_BY_DIGITS: Mapping[int, HsLevel] = {2: "chapter", 4: "heading", 6: "subheading", 8: "national8"}
EMBEDDING_DIM = 1024

VERSION_RE = re.compile(r"^(HS|ITCHS)([0-9]{4})$")
CODE_RE = re.compile(r"^(?:[0-9]{2}|[0-9]{4}|[0-9]{6}|[0-9]{8})$")
MAX_ERRORS_REPORTED = 20

# EV-12 NomenclatureVersionLoaded {version}
EV_NOMENCLATURE_VERSION_LOADED = "nomenclature.version_loaded"

WCO_SOURCE_ID = "nomenclature.wco.hs"
ITCHS_SOURCE_ID = "nomenclature.in.itchs"


class HsLoadError(KpError):
    """A nomenclature load was rejected; nothing was written."""

    def __init__(self, message: str, problems: Sequence[str] | None = None, **details: object) -> None:
        d: dict[str, object] = dict(details)
        if problems:
            d["problems"] = list(problems[:MAX_ERRORS_REPORTED])
            d["problem_count"] = len(problems)
        super().__init__("VALIDATION", message, d)


def version_family(version: str) -> str:
    m = VERSION_RE.match(version or "")
    if not m:
        raise KpError("VALIDATION", f'Invalid HS nomenclature version "{version}"', {"version": version})
    return m.group(1)


def corresponding_hs_version(version: str) -> str:
    """``ITCHS2022`` → ``HS2022``; HS versions map to themselves."""
    m = VERSION_RE.match(version or "")
    if not m:
        raise KpError("VALIDATION", f'Invalid HS nomenclature version "{version}"', {"version": version})
    return f"HS{m.group(2)}"


def assert_version(version: str, family: str) -> str:
    if version_family(version) != family:
        raise KpError("VALIDATION", f'Version "{version}" is not an {family} version', {"version": version})
    return version


def level_for(code: str) -> HsLevel:
    lvl = LEVEL_BY_DIGITS.get(len(code))
    if lvl is None or not CODE_RE.match(code):
        raise KpError("VALIDATION", f'"{code}" is not a 2, 4, 6 or 8 digit HS code', {"code": code})
    return lvl


def parent_of(code: str) -> str | None:
    """Structural parent: 8 → 6, 6 → 4, 4 → 2 digits; chapters have none."""
    if len(code) == 2:
        return None
    return code[: len(code) - 2]


_EX_RE = re.compile(r"^\s*ex\s*", re.IGNORECASE)
_SEPARATORS_RE = re.compile(r"[\s.\-/]")


def normalize_code(raw: object) -> str | None:
    """Normalizes a code cell: '0101.21' / '0101 21' / 'ex 0101.21' / 10121 → '010121'.

    Spreadsheets often store codes as numbers, which drops the leading zero of chapters 01–09;
    an odd digit count is therefore padded with one leading zero. Returns None for cells that are
    not codes (headers, blanks, notes, 5- or 7-digit groupings).
    """
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, float):
        if not raw.is_integer():
            # '0101.21' stored as the number 101.21 (or '0101.20' as 101.2): heading part is the
            # integer (zero-padded to 4), subheading digits the fraction (zero-padded on the right).
            parts = repr(raw).split(".")
            if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
                return None
            ip, fp = parts
            if len(ip) > 4 or len(fp) > 4:
                return None
            digits = ip.zfill(4) + fp.ljust(2 if len(fp) <= 2 else 4, "0")
            return digits if CODE_RE.match(digits) else None
        text = str(int(raw))
    else:
        text = str(raw)
    text = _EX_RE.sub("", text.strip())
    if not text:
        return None
    digits = _SEPARATORS_RE.sub("", text)
    if not digits.isdigit():
        return None
    if len(digits) in (1, 3, 5, 7) and isinstance(raw, (int, float)):
        digits = "0" + digits
    elif len(digits) in (3, 5, 7) and "." in text and text.split(".")[0].isdigit() and len(text.split(".")[0]) == 3:
        # '101.21' typed as text: the chapter lost its leading zero.
        digits = "0" + digits
    if not CODE_RE.match(digits):
        return None
    return digits


_POLICY_MAP: Mapping[str, ExportPolicy] = {
    "free": "free",
    "restricted": "restricted",
    "prohibited": "prohibited",
    "ste": "ste",
    "state trading enterprise": "ste",
    "state trading enterprises": "ste",
    "canalised": "ste",
    "canalized": "ste",
}


def normalize_policy(raw: object) -> ExportPolicy | None:
    """Maps DGFT policy wording ('Free', 'Restricted', 'Prohibited', 'STE', 'State Trading
    Enterprise') to the stored enum. Blank → None. Unknown wording raises VALIDATION."""
    if raw is None:
        return None
    text = re.sub(r"\s+", " ", str(raw)).strip().lower().rstrip(".")
    if not text or text in ("-", "--", "n/a", "na"):
        return None
    if text in _POLICY_MAP:
        return _POLICY_MAP[text]
    head = text.split(" ")[0].strip(",;:()")
    if head in _POLICY_MAP:
        return _POLICY_MAP[head]
    if "state trading" in text:
        return "ste"
    raise KpError("VALIDATION", f'Unrecognised export policy "{raw}"', {"policy": str(raw)[:100]})


def clean_text(raw: object, max_len: int) -> str | None:
    if raw is None:
        return None
    text = re.sub(r"\s+", " ", str(raw)).strip()
    if not text:
        return None
    return text[:max_len]


@dataclass
class HsCodeRow:
    version: str
    code: str
    level: HsLevel
    parent_code: str | None
    description: str
    description_en_simple: str | None = None
    export_policy: ExportPolicy | None = None
    policy_conditions: str | None = None
    policy_source_url: str | None = None
    embedding: list[float] | None = None

    def embed_text(self) -> str:
        return self.description_en_simple or self.description

    def as_value(self) -> dict[str, object]:
        return {
            "version": self.version, "code": self.code, "level": self.level, "parent_code": self.parent_code,
            "description": self.description, "description_en_simple": self.description_en_simple,
            "export_policy": self.export_policy, "policy_conditions": self.policy_conditions,
            "policy_source_url": self.policy_source_url,
        }

    @classmethod
    def from_value(cls, v: Mapping[str, object]) -> "HsCodeRow":
        return cls(
            version=str(v["version"]), code=str(v["code"]), level=v["level"],  # type: ignore[arg-type]
            parent_code=v.get("parent_code"),  # type: ignore[arg-type]
            description=str(v["description"]),
            description_en_simple=v.get("description_en_simple"),  # type: ignore[arg-type]
            export_policy=v.get("export_policy"),  # type: ignore[arg-type]
            policy_conditions=v.get("policy_conditions"),  # type: ignore[arg-type]
            policy_source_url=v.get("policy_source_url"),  # type: ignore[arg-type]
        )


@dataclass(frozen=True)
class CorrelationPair:
    from_code: str
    to_code: str


@dataclass(frozen=True)
class CorrelationRow:
    from_version: str
    from_code: str
    to_version: str
    to_code: str
    relation: Relation


@dataclass
class VersionLoadResult:
    version: str
    codes: int = 0
    embedded: int = 0
    embeddings_reused: int = 0
    embeddings_skipped: int = 0
    made_current: bool = False
    event_id: str | None = None
    warnings: list[str] = field(default_factory=list)


def merge_duplicates(rows: Iterable[HsCodeRow]) -> tuple[list[HsCodeRow], list[str]]:
    """Keeps one row per code. Identical duplicates are dropped silently; conflicting duplicates
    (different description or policy) are problems."""
    by_code: dict[str, HsCodeRow] = {}
    problems: list[str] = []
    for r in rows:
        prev = by_code.get(r.code)
        if prev is None:
            by_code[r.code] = r
            continue
        if (prev.description, prev.export_policy) != (r.description, r.export_policy):
            if prev.description != r.description and prev.export_policy == r.export_policy:
                # Continuation lines of a long description: keep the longer text.
                if r.description.startswith(prev.description) or prev.description.startswith(r.description):
                    if len(r.description) > len(prev.description):
                        by_code[r.code] = r
                    continue
            problems.append(f"{r.code}: conflicting duplicate rows")
    return [by_code[c] for c in sorted(by_code)], problems


def validate_hs_tree(version: str, rows: Sequence[HsCodeRow]) -> list[str]:
    """WCO version checks: only 2/4/6-digit codes, each non-chapter code's parent present."""
    problems: list[str] = []
    codes = {r.code for r in rows}
    for r in rows:
        if r.version != version:
            problems.append(f"{r.code}: row version {r.version} != {version}")
        if r.level == "national8":
            problems.append(f"{r.code}: 8-digit lines belong to an ITC-HS version, not {version}")
            continue
        if r.level != level_for(r.code):
            problems.append(f"{r.code}: level {r.level} does not match its length")
        expected = parent_of(r.code)
        if r.parent_code != expected:
            problems.append(f"{r.code}: parent {r.parent_code} != {expected}")
        elif expected is not None and expected not in codes:
            problems.append(f"{r.code}: parent {expected} is missing (orphan)")
        if r.export_policy is not None or r.policy_conditions is not None or r.policy_source_url is not None:
            problems.append(f"{r.code}: export policy is only recorded on 8-digit national lines")
    if not any(r.level == "chapter" for r in rows):
        problems.append("no chapters in the table")
    return problems


def validate_national_lines(version: str, rows: Sequence[HsCodeRow], hs_subheadings: set[str]) -> list[str]:
    """ITC-HS checks: 8-digit only, and every line's 6-digit parent exists in the corresponding
    HS version (LLD M12: orphans fail the load)."""
    problems: list[str] = []
    for r in rows:
        if r.version != version:
            problems.append(f"{r.code}: row version {r.version} != {version}")
        if r.level != "national8" or len(r.code) != 8:
            problems.append(f"{r.code}: ITC-HS versions hold 8-digit national lines only")
            continue
        if r.parent_code != r.code[:6]:
            problems.append(f"{r.code}: parent {r.parent_code} != {r.code[:6]}")
        elif r.parent_code not in hs_subheadings:
            problems.append(f"{r.code}: 6-digit parent {r.parent_code} not in {corresponding_hs_version(version)} (orphan)")
    return problems


def derive_relations(from_version: str, to_version: str, pairs: Iterable[CorrelationPair]) -> list[CorrelationRow]:
    """Relation of each pair from the table's cardinalities: '1:n' when the source splits into
    several targets, 'n:1' when several sources merge into the target, 'n:n' when both."""
    uniq = sorted({(p.from_code, p.to_code) for p in pairs})
    targets: dict[str, set[str]] = defaultdict(set)
    sources: dict[str, set[str]] = defaultdict(set)
    for f, t in uniq:
        targets[f].add(t)
        sources[t].add(f)
    out: list[CorrelationRow] = []
    for f, t in uniq:
        rel = f"{'n' if len(sources[t]) > 1 else '1'}:{'n' if len(targets[f]) > 1 else '1'}"
        out.append(CorrelationRow(from_version, f, to_version, t, rel))  # type: ignore[arg-type]
    return out
