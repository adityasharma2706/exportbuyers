"""M24 rollup (LLD M24 "Rollup", ``RULE_V=1``, deterministic).

    low     if any check fails in {sanctions, registered_entity}, or if >= 2 checks fail.
    high    if registered_entity passes AND >= 4 checks pass AND nothing fails.
    medium  if >= 2 checks pass and at most 1 fails.
    unknown otherwise.

Bumping ``RULE_V`` is the only way this logic may change once it has been used in production: the
rule version is stored on every ``trust.rollup`` assertion (LLD: "a deterministic, versioned
rollup ... with the rule version stored"), so a past rollup's reasoning stays legible even after
the rule changes.
"""
from __future__ import annotations

from datetime import datetime

from .models import CHECK_IDS, CheckOutcome, RollupResult, TrustLevel, utcnow

RULE_V = 1

# The wording *set* version these outcomes are meant to be rendered with. M37 (the wording/copy
# module) owns the actual copy and its own versioning once it exists; until then M24 tracks the
# version of its own `explanation_key` vocabulary here, so a rollup already computed and stored
# stays attributable to the shape of keys it was produced with. Bump this whenever `checks.py`
# adds, removes or renames an `explanation_key` suffix (e.g. `trust.check.<id>.<reason>`), so a
# consumer rendering an old stored rollup can tell its keys apart from the current vocabulary.
COPY_VERSION = "1"

GATING_CHECKS: tuple[str, ...] = ("sanctions", "registered_entity")
HIGH_MIN_PASSES = 4   # [tunable]
MEDIUM_MIN_PASSES = 2  # [tunable]
MEDIUM_MAX_FAILS = 1   # [tunable]


def compute_level(checks: dict[str, CheckOutcome]) -> TrustLevel:
    passes = [c for c in CHECK_IDS if c in checks and checks[c].outcome == "pass"]
    fails = [c for c in CHECK_IDS if c in checks and checks[c].outcome == "fail"]

    if any(c in fails for c in GATING_CHECKS) or len(fails) >= 2:
        return "low"
    registered_entity_pass = checks.get("registered_entity") is not None and checks["registered_entity"].outcome == "pass"
    if registered_entity_pass and len(passes) >= HIGH_MIN_PASSES and not fails:
        return "high"
    if len(passes) >= MEDIUM_MIN_PASSES and len(fails) <= MEDIUM_MAX_FAILS:
        return "medium"
    return "unknown"


def compute_rollup(checks: dict[str, CheckOutcome], *, now: datetime | None = None) -> RollupResult:
    return RollupResult(
        level=compute_level(checks), rule_version=RULE_V, copy_version=COPY_VERSION,
        checks=dict(checks), computed_at=now or utcnow(),
    )
