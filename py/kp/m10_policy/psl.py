"""Public Suffix List matching over the pinned, shared file ``spec/normalisation/public_suffix_list.dat``.

Mirrors ``apps/web/src/modules/m10_policy/psl.ts``: exception rules win; otherwise the longest
matching rule (normal or wildcard); otherwise the implicit ``*`` rule (the TLD alone).
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

from kp.m01_platform import KpError, get_logger

_log = get_logger("kp.m10_policy.psl")

PSL_RELATIVE_PATH = Path("spec") / "normalisation" / "public_suffix_list.dat"


@dataclass
class PslRules:
    normal: set[str] = field(default_factory=set)
    wildcard: set[str] = field(default_factory=set)
    exception: set[str] = field(default_factory=set)


def parse_psl(text: str) -> PslRules:
    rules = PslRules()
    for raw_line in text.splitlines():
        parts = raw_line.strip().split()
        line = parts[0] if parts else ""
        if not line or line.startswith("//"):
            continue
        rule = line.lower()
        if rule.startswith("!"):
            rules.exception.add(rule[1:])
        elif rule.startswith("*."):
            rules.wildcard.add(rule[2:])
        else:
            rules.normal.add(rule)
    return rules


def public_suffix_length(rules: PslRules, labels: list[str]) -> int:
    n = len(labels)
    if n == 0:
        return 0
    for i in range(n):
        if ".".join(labels[i:]) in rules.exception:
            return n - i - 1
    for i in range(n):
        if ".".join(labels[i:]) in rules.normal:
            return n - i
        if i + 1 < n and ".".join(labels[i + 1:]) in rules.wildcard:
            return n - i
    return 1


def registrable_domain(rules: PslRules, host: str) -> str:
    labels = [label for label in host.split(".") if label]
    if not labels:
        return host
    suffix_len = public_suffix_length(rules, labels)
    if suffix_len >= len(labels):
        return ".".join(labels)
    return ".".join(labels[len(labels) - suffix_len - 1:])


_lock = threading.Lock()
_loaded: PslRules | None = None


def _candidates() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("M10_PSL_FILE", "").strip()
    if env:
        out.append(Path(env).resolve())
    # py/kp/m10_policy/psl.py → repository root is three levels above the package directory.
    out.append(Path(__file__).resolve().parents[3] / PSL_RELATIVE_PATH)
    d = Path.cwd().resolve()
    for _ in range(8):
        out.append(d / PSL_RELATIVE_PATH)
        if d.parent == d:
            break
        d = d.parent
    return out


def psl_rules() -> PslRules:
    global _loaded
    if _loaded is not None:
        return _loaded
    with _lock:
        if _loaded is not None:
            return _loaded
        for p in _candidates():
            if p.is_file():
                _loaded = parse_psl(p.read_text(encoding="utf-8"))
                _log.info("m10 public suffix list loaded", extra={"path": str(p)})
                return _loaded
    raise KpError("INTERNAL", f"Pinned public suffix list not found ({PSL_RELATIVE_PATH}); set M10_PSL_FILE")


def set_psl_rules_for_testing(text: str | None) -> None:
    global _loaded
    with _lock:
        _loaded = None if text is None else parse_psl(text)
