"""M24 Trust engine — Python public API.

REQ-027 (trust checks and level), REQ-028 (never claim "verified genuine").

- Six pluggable checks (``checks.py``): ``registered_entity``, ``website_consistent``,
  ``domain_age``, ``corporate_email``, ``recent_trade`` (unknown without M21 data) and
  ``sanctions``. Each returns pass / fail / unknown with ``checked_at`` and an optional
  supporting-assertion id.
- A deterministic, versioned rollup (``rollup.py``, ``RULE_V=1``) to high / medium / low /
  unknown, with the rule version stored on the written ``trust.rollup`` assertion.
- ``engine.evaluate_company`` (EV-01 job path, writes ``trust.check.<id>`` / ``trust.rollup`` plus
  the supporting M09 evidence) and ``engine.evaluate_adhoc`` (IF-24b, M32's free-text use — no
  writes at all).
- ``jobs.register_trust_jobs()`` wires ``m24.evaluate`` to EV-01 (filtered to attribute classes in
  {registry, domain, contact, activity_aggregate, sanctions_flag}).
- ``rpc.build_router()`` / ``rpc.create_app()``: ``POST /rpc/trust/adhoc``.

Wording is never inlined: every outcome and the rollup itself carry only an ``explanation_key``;
the actual copy is rendered elsewhere (LLD: "wording lives only in M37 keys") and must never read
as "verified", "genuine" or "guaranteed" (see ``test_m24_trust.py``).

Other knowledge-plane modules import only from here.
"""
from .budget import CHECK_BUDGET_S, RPC_BUDGET_S
from .checks import CHECKS, CheckContext, run_checks
from .engine import PRODUCER, SOURCE_ID, evaluate_adhoc, evaluate_company
from .jobs import (
    EVALUATE_JOB,
    TRIGGER_CLASSES,
    enqueue_evaluate,
    register_trust_jobs,
    reset_registration_for_testing,
    run_evaluate,
)
from .models import CHECK_IDS, TRUST_LEVELS, TRUST_OUTCOMES, CheckOutcome, RollupResult, TrustSubject
from .rollup import COPY_VERSION, RULE_V, compute_level, compute_rollup
from .rpc import AdhocRequest, build_router, create_app

__all__ = [
    "CHECKS",
    "CHECK_BUDGET_S",
    "CHECK_IDS",
    "COPY_VERSION",
    "EVALUATE_JOB",
    "PRODUCER",
    "RPC_BUDGET_S",
    "RULE_V",
    "SOURCE_ID",
    "TRIGGER_CLASSES",
    "TRUST_LEVELS",
    "TRUST_OUTCOMES",
    "AdhocRequest",
    "CheckContext",
    "CheckOutcome",
    "RollupResult",
    "TrustSubject",
    "build_router",
    "compute_level",
    "compute_rollup",
    "create_app",
    "enqueue_evaluate",
    "evaluate_adhoc",
    "evaluate_company",
    "register_trust_jobs",
    "reset_registration_for_testing",
    "run_checks",
    "run_evaluate",
]
