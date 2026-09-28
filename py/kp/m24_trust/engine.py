"""M24 engine: the two entry points named in the LLD.

- ``evaluate_company(company_id, tx=None)``  — the EV-01 job path (``jobs.py``). Loads the
  canonical company, runs the six checks one at a time (so a check's M09 write is never touched
  from more than one thread — see ``checks.py``), and writes ``trust.check.<id>`` and
  ``trust.rollup`` (LLD: "It writes trust.check.<id> and trust.rollup {level, rule_version,
  copy_version}").
- ``evaluate_adhoc(subject)``                 — IF-24b, M32's ad hoc use. Runs the six checks
  concurrently (safe: nothing is written) and returns the rollup with **no writes at all** (LLD:
  "DS-08 with no writes").
"""
from __future__ import annotations

from dataclasses import replace
from typing import Any

from kp.m01_platform import get_logger, span
from kp.m09_evidence import (
    AssertionIn,
    Company,
    CompanyNotFound,
    open_repo,
    resolve_company_id,
    write_assertion,
)
from kp.m09_evidence import get_company as _get_company

from .checks import CheckContext, run_checks
from .models import CheckOutcome, RollupResult, TrustSubject, utcnow
from .rollup import RULE_V, compute_rollup

_log = get_logger("kp.m24_trust.engine")

SOURCE_ID = "trust.engine"
PRODUCER = "m24.trust"
PRODUCER_VERSION = str(RULE_V)


def _company_subject(company: Company) -> TrustSubject:
    return TrustSubject(
        company_id=company.id, name=company.display_name, country=company.country, city=company.city,
        domain=company.primary_domain, is_adhoc=False,
    )


def _json_safe(v: Any) -> Any:
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    return str(v)


def _write_check(tx: Any, company_id: str, region: str | None, o: CheckOutcome) -> CheckOutcome:
    value: dict[str, Any] = {"outcome": o.outcome, "checked_at": o.checked_at.isoformat(), "rule_version": RULE_V}
    if o.detail:
        value["detail"] = {k: _json_safe(v) for k, v in o.detail.items()}
    aid = write_assertion(AssertionIn(
        subject_id=company_id, attribute=f"trust.check.{o.check_id}", value=value, source_id=SOURCE_ID,
        source_ref={"producer": PRODUCER, "check": o.check_id, "rule_version": RULE_V,
                    "explanation_key": o.explanation_key},
        observed_at=o.checked_at, checked_at=o.checked_at,
        confidence=1.0 if o.outcome != "unknown" else 0.5, region=region,
        producer=PRODUCER, producer_version=PRODUCER_VERSION,
    ), tx=tx)
    return o if aid is None else replace(o, assertion_id=aid)


def _write_rollup(tx: Any, company_id: str, region: str | None, rollup: RollupResult) -> RollupResult:
    value = {"level": rollup.level, "rule_version": rollup.rule_version, "copy_version": rollup.copy_version}
    aid = write_assertion(AssertionIn(
        subject_id=company_id, attribute="trust.rollup", value=value, source_id=SOURCE_ID,
        source_ref={"producer": PRODUCER, "rule_version": rollup.rule_version}, observed_at=rollup.computed_at,
        checked_at=rollup.computed_at, confidence=1.0, region=region, producer=PRODUCER,
        producer_version=PRODUCER_VERSION,
    ), tx=tx)
    return replace(rollup, assertion_id=aid)


def _run_and_write(company: Company, tx: Any) -> RollupResult:
    subject = _company_subject(company)
    ctx = CheckContext(tx=tx, company=company, record=True, now=utcnow())
    outcomes = run_checks(subject, ctx, concurrent=False)
    rollup = compute_rollup(outcomes, now=ctx.now)
    written = {cid: _write_check(tx, company.id, company.country, o) for cid, o in outcomes.items()}
    return _write_rollup(tx, company.id, company.country, replace(rollup, checks=written))


def evaluate_company(company_id: str, *, tx: Any = None) -> RollupResult:
    """The EV-01 job path. Raises ``CompanyNotFound`` when the company does not resolve."""
    with span("m24.evaluate_company", {"company_id": str(company_id)}):
        if tx is not None:
            cid = resolve_company_id(company_id, tx=tx)
            company = _get_company(cid, tx=tx)
            if company is None:
                raise CompanyNotFound(cid)
            return _run_and_write(company, tx)
        with open_repo(None) as repo:
            cid = resolve_company_id(company_id, tx=repo)
            company = _get_company(cid, tx=repo)
            if company is None:
                raise CompanyNotFound(cid)
            return _run_and_write(company, repo)


def evaluate_adhoc(subject: TrustSubject) -> RollupResult:
    """IF-24b: free-text checks (M32). No M09 reads or writes; nothing is persisted."""
    adhoc = replace(subject, company_id=None, is_adhoc=True)
    with span("m24.evaluate_adhoc", {"label": adhoc.label()}):
        ctx = CheckContext(tx=None, company=None, record=False, now=utcnow())
        outcomes = run_checks(adhoc, ctx, concurrent=True)
        return compute_rollup(outcomes, now=ctx.now)
