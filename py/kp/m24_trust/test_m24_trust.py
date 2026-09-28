"""M24 tests: the rollup rule, each check in isolation (vendor calls monkey-patched — no network
or database), the end-to-end write path against an in-memory M09 repo, the budget wrapper and the
IF-24b ad hoc RPC. No test opens a real socket or a real database connection.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Iterable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kp.m08_sources import HttpResponse, register_entries_loader, set_source_loader_for_testing, validate_entry
from kp.m09_evidence import MemoryEvidenceRepo, create_company, get_assertions, set_suppression_checker
from kp.m17_sanctions import ScreenResult
from kp.m23_registry import DomainSignals, RegistryMatch, Unavailable

from . import checks as checks_mod
from .budget import run_with_budget
from .checks import CheckContext, check_corporate_email, check_domain_age, check_recent_trade, check_registered_entity, check_sanctions, check_website_consistent
from .engine import evaluate_adhoc, evaluate_company
from .models import CHECK_IDS, CheckOutcome, TrustSubject
from .rollup import compute_level, compute_rollup
from .rpc import build_router

FORBIDDEN = re.compile(r"verified|genuine|guaranteed", re.IGNORECASE)
_PAD = b" padding text to clear the 200-byte parked-page floor" * 4  # never matches a parked-page marker


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _outcome(check_id: str, outcome: str) -> CheckOutcome:
    return CheckOutcome(check_id=check_id, outcome=outcome, checked_at=_now(),  # type: ignore[arg-type]
                       explanation_key=f"trust.check.{check_id}.{outcome}")


def _src(id: str, source_type: str = "operator") -> Any:
    return validate_entry({
        "id": id, "source_type": source_type, "can_store": False, "can_display": True, "can_export": True,
        "retention_days": None, "attribution_text": f"Source {id}", "personal_data_class": "none",
        "allowed_regions": ["*"], "status": "active",
    })


@pytest.fixture(autouse=True)
def _sources() -> Iterable[None]:
    set_source_loader_for_testing(register_entries_loader([
        _src("trust.engine"), _src("registry.gleif", "registry"), _src("registry.gb.ch", "registry"),
        _src("domain.rdap", "registry"), _src("domain.whois", "registry"), _src("domain.dns", "website"),
        _src("list.freemail", "directory"),
    ]))
    set_suppression_checker(None)
    yield
    set_source_loader_for_testing(None)
    set_suppression_checker(None)


# ---- rollup -------------------------------------------------------------------------------------

def test_rollup_low_on_sanctions_fail() -> None:
    checks = {"sanctions": _outcome("sanctions", "fail"), "registered_entity": _outcome("registered_entity", "pass")}
    assert compute_level(checks) == "low"


def test_rollup_low_on_registered_entity_fail() -> None:
    checks = {"registered_entity": _outcome("registered_entity", "fail")}
    assert compute_level(checks) == "low"


def test_rollup_low_on_two_fails() -> None:
    checks = {c: _outcome(c, "fail") for c in ("domain_age", "corporate_email")}
    assert compute_level(checks) == "low"


def test_rollup_high() -> None:
    checks = {c: _outcome(c, "pass") for c in CHECK_IDS}
    assert compute_level(checks) == "high"


def test_rollup_high_requires_registered_entity_pass() -> None:
    checks = {c: _outcome(c, "pass") for c in CHECK_IDS if c != "registered_entity"}
    checks["registered_entity"] = _outcome("registered_entity", "unknown")
    assert compute_level(checks) == "medium"  # 4 passes, 0 fails, but not high without registered_entity


def test_rollup_medium() -> None:
    checks = {"registered_entity": _outcome("registered_entity", "pass"), "domain_age": _outcome("domain_age", "pass"),
              "sanctions": _outcome("sanctions", "unknown")}
    assert compute_level(checks) == "medium"


def test_rollup_medium_tolerates_one_fail() -> None:
    checks = {"registered_entity": _outcome("registered_entity", "pass"), "domain_age": _outcome("domain_age", "pass"),
              "corporate_email": _outcome("corporate_email", "fail")}
    assert compute_level(checks) == "medium"


def test_rollup_unknown_when_nothing_conclusive() -> None:
    checks = {c: _outcome(c, "unknown") for c in CHECK_IDS}
    assert compute_level(checks) == "unknown"


def test_rollup_carries_rule_and_copy_version() -> None:
    r = compute_rollup({c: _outcome(c, "unknown") for c in CHECK_IDS})
    assert r.rule_version == 1
    assert isinstance(r.copy_version, str) and r.copy_version


# ---- individual checks (vendor calls monkey-patched) --------------------------------------------

def _ctx(**kw: Any) -> CheckContext:
    return CheckContext(tx=None, company=None, record=False, now=_now(), **kw)


def test_registered_entity_unavailable_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(checks_mod, "registry_lookup",
                        lambda name, country: Unavailable(source="registry", reason="upstream_error"))
    out = check_registered_entity(TrustSubject(name="Acme Trading Ltd", country="GB"), _ctx())
    assert out.outcome == "unknown"


def test_registered_entity_dissolved_is_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    match = RegistryMatch(matched=True, query_name="Acme", query_country="GB", checked_at=_now().isoformat(),
                          sources_checked=("registry.gb.ch",), source_id="registry.gb.ch", legal_name="Acme Ltd",
                          status="dissolved", name_similarity=0.97)
    monkeypatch.setattr(checks_mod, "registry_lookup", lambda name, country: match)
    out = check_registered_entity(TrustSubject(name="Acme", country="GB"), _ctx())
    assert out.outcome == "fail"


def test_registered_entity_strong_match_is_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    match = RegistryMatch(matched=True, query_name="Acme", query_country="GB", checked_at=_now().isoformat(),
                          sources_checked=("registry.gb.ch",), source_id="registry.gb.ch", legal_name="Acme Ltd",
                          status="active", name_similarity=0.95)
    monkeypatch.setattr(checks_mod, "registry_lookup", lambda name, country: match)
    out = check_registered_entity(TrustSubject(name="Acme", country="GB"), _ctx())
    assert out.outcome == "pass"


def test_registered_entity_weak_match_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    match = RegistryMatch(matched=True, query_name="Acme", query_country="GB", checked_at=_now().isoformat(),
                          sources_checked=("registry.gb.ch",), source_id="registry.gb.ch", legal_name="Ace Ltd",
                          status="active", name_similarity=0.6)
    monkeypatch.setattr(checks_mod, "registry_lookup", lambda name, country: match)
    out = check_registered_entity(TrustSubject(name="Acme", country="GB"), _ctx())
    assert out.outcome == "unknown"


def test_registered_entity_no_name_is_unknown() -> None:
    out = check_registered_entity(TrustSubject(country="GB"), _ctx())
    assert out.outcome == "unknown" and out.explanation_key.endswith("no_subject")


def test_domain_age_pass_fail_and_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    def _sig(age: int | None) -> DomainSignals:
        return DomainSignals(domain="acme.com", age_days=age, has_mx=True, is_freemail=False, rdap_available=True,
                             checked_at=_now().isoformat(), age_source="rdap" if age is not None else None)

    monkeypatch.setattr(checks_mod, "domain_signals", lambda d: _sig(1000))
    assert check_domain_age(TrustSubject(domain="acme.com"), _ctx()).outcome == "pass"

    monkeypatch.setattr(checks_mod, "domain_signals", lambda d: _sig(100))
    assert check_domain_age(TrustSubject(domain="acme.com"), _ctx()).outcome == "fail"

    monkeypatch.setattr(checks_mod, "domain_signals", lambda d: _sig(400))
    assert check_domain_age(TrustSubject(domain="acme.com"), _ctx()).outcome == "unknown"

    monkeypatch.setattr(checks_mod, "domain_signals", lambda d: _sig(None))
    assert check_domain_age(TrustSubject(domain="acme.com"), _ctx()).outcome == "unknown"


def test_domain_age_no_domain_is_unknown() -> None:
    out = check_domain_age(TrustSubject(), _ctx())
    assert out.outcome == "unknown" and out.explanation_key.endswith("no_domain")


def test_corporate_email_no_email_is_unknown() -> None:
    out = check_corporate_email(TrustSubject(website="acme.com"), _ctx())
    assert out.outcome == "unknown" and out.explanation_key.endswith("no_email")


def test_corporate_email_on_company_domain_is_pass() -> None:
    subject = TrustSubject(website="acme.com", email="sales@acme.com")
    assert check_corporate_email(subject, _ctx()).outcome == "pass"


def test_corporate_email_freemail_only_is_fail() -> None:
    subject = TrustSubject(website="acme.com", email="acme.trading@gmail.com")
    out = check_corporate_email(subject, _ctx())
    assert out.outcome == "fail" and out.explanation_key.endswith("freemail_only")


def test_corporate_email_unconfirmed_domain_is_unknown() -> None:
    subject = TrustSubject(website="acme.com", email="sales@some-agency.example")
    out = check_corporate_email(subject, _ctx())
    assert out.outcome == "unknown"


def test_recent_trade_without_company_is_unknown() -> None:
    out = check_recent_trade(TrustSubject(name="Acme"), _ctx())
    assert out.outcome == "unknown" and out.explanation_key.endswith("no_customs_data")


def test_sanctions_clear_is_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(checks_mod, "screen_name", lambda name, country: ScreenResult(
        subject_key="adhoc:x", result="clear", raw_result="clear", best_score=0.0, screened_at=_now()))
    out = check_sanctions(TrustSubject(name="Acme", country="GB"), _ctx())
    assert out.outcome == "pass"


def test_sanctions_hit_is_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(checks_mod, "screen_name", lambda name, country: ScreenResult(
        subject_key="adhoc:x", result="hit", raw_result="hit", best_score=98.0, screened_at=_now()))
    out = check_sanctions(TrustSubject(name="Acme", country="GB"), _ctx())
    assert out.outcome == "fail"


def test_sanctions_no_name_is_unknown() -> None:
    out = check_sanctions(TrustSubject(website="acme.com"), _ctx())
    assert out.outcome == "unknown"


def test_website_consistent_no_domain_is_unknown() -> None:
    out = check_website_consistent(TrustSubject(name="Acme"), _ctx())
    assert out.outcome == "unknown" and out.explanation_key.endswith("no_domain")


def test_website_consistent_matching_title_is_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    body = b"<html><head><title>Acme Trading Ltd - Home</title></head><body>hello world" + _PAD + b"</body></html>"
    monkeypatch.setattr(checks_mod, "http_fetch", lambda url, timeout=None: HttpResponse(
        url=url, status=200, headers={}, body=body))
    out = check_website_consistent(TrustSubject(name="Acme Trading Ltd", website="acme.com"), _ctx())
    assert out.outcome == "pass"


def test_website_consistent_parked_is_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    body = b"<html><title>acme.com</title><body>This domain is parked. Buy this domain today!</body></html>"
    monkeypatch.setattr(checks_mod, "http_fetch", lambda url, timeout=None: HttpResponse(
        url=url, status=200, headers={}, body=body))
    out = check_website_consistent(TrustSubject(name="Acme Trading Ltd", website="acme.com"), _ctx())
    assert out.outcome == "fail" and out.explanation_key.endswith("parked")


def test_website_consistent_mismatched_title_is_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    body = b"<html><title>Totally Unrelated Widgets Inc</title><body>" + _PAD + b"</body></html>"
    monkeypatch.setattr(checks_mod, "http_fetch", lambda url, timeout=None: HttpResponse(
        url=url, status=200, headers={}, body=body))
    out = check_website_consistent(TrustSubject(name="Acme Trading Ltd", website="acme.com"), _ctx())
    assert out.outcome == "fail" and out.explanation_key.endswith("name_mismatch")


def test_website_consistent_suppressed_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(checks_mod, "is_suppressed", lambda kind, raw: True)
    out = check_website_consistent(TrustSubject(name="Acme", website="acme.com"), _ctx())
    assert out.outcome == "unknown" and out.explanation_key.endswith("suppressed")


# ---- end-to-end write path (in-memory M09 repo) --------------------------------------------------

def test_evaluate_company_writes_checks_and_rollup(monkeypatch: pytest.MonkeyPatch) -> None:
    repo = MemoryEvidenceRepo()
    cid = create_company(repo, display_name="Acme Trading Ltd", country="GB", primary_domain="acme.com")

    monkeypatch.setattr(checks_mod, "registry_lookup", lambda name, country: RegistryMatch(
        matched=True, query_name=name, query_country=country, checked_at=_now().isoformat(),
        sources_checked=("registry.gb.ch",), source_id="registry.gb.ch", legal_name="Acme Trading Ltd",
        status="active", name_similarity=0.97))
    monkeypatch.setattr(checks_mod, "domain_signals", lambda d: DomainSignals(
        domain=d, age_days=1500, has_mx=True, is_freemail=False, rdap_available=True,
        checked_at=_now().isoformat(), age_source="rdap"))
    monkeypatch.setattr(checks_mod, "http_fetch", lambda url, timeout=None: HttpResponse(
        url=url, status=200, headers={}, body=b"<title>Acme Trading Ltd</title>" + _PAD))
    monkeypatch.setattr(checks_mod, "screen_company", lambda company_id, tx=None: ScreenResult(
        subject_key=str(company_id), result="clear", raw_result="clear", best_score=0.0, screened_at=_now()))

    rollup = evaluate_company(cid, tx=repo)

    assert rollup.level in ("high", "medium", "low", "unknown")
    assert rollup.assertion_id is not None
    written = get_assertions(cid, ["trust.rollup"], tx=repo)
    assert len(written) == 1 and written[0].value["rule_version"] == rollup.rule_version
    for check_id in CHECK_IDS:
        rows = get_assertions(cid, [f"trust.check.{check_id}"], tx=repo)
        assert len(rows) == 1
        assert rows[0].value["outcome"] in ("pass", "fail", "unknown")
    # registered_entity, domain_age and sanctions should all have passed given the fakes above.
    assert rollup.checks["registered_entity"].outcome == "pass"
    assert rollup.checks["domain_age"].outcome == "pass"
    assert rollup.checks["sanctions"].outcome == "pass"


def test_evaluate_adhoc_never_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(checks_mod, "registry_lookup",
                        lambda name, country: Unavailable(source="registry", reason="upstream_error"))
    monkeypatch.setattr(checks_mod, "domain_signals", lambda d: DomainSignals(
        domain=d, age_days=None, has_mx=None, is_freemail=False, rdap_available=False, checked_at=_now().isoformat()))
    monkeypatch.setattr(checks_mod, "http_fetch", lambda url, timeout=None: (_ for _ in ()).throw(RuntimeError("no net")))
    monkeypatch.setattr(checks_mod, "screen_name", lambda name, country: ScreenResult(
        subject_key="adhoc:x", result="clear", raw_result="clear", best_score=0.0, screened_at=_now()))
    result = evaluate_adhoc(TrustSubject(name="Acme", website="acme.com", country="GB"))
    assert result.assertion_id is None
    assert all(o.assertion_id is None for o in result.checks.values())


# ---- explanation keys never say "verified" / "genuine" / "guaranteed" ---------------------------

def test_no_forbidden_words_in_explanation_keys() -> None:
    for check_id in CHECK_IDS:
        for outcome in ("pass", "fail", "unknown"):
            key = _outcome(check_id, outcome).explanation_key
            assert not FORBIDDEN.search(key)
    for level in ("high", "medium", "low", "unknown"):
        assert not FORBIDDEN.search(level)


# ---- budget -------------------------------------------------------------------------------------

def test_run_with_budget_returns_fast_result() -> None:
    assert run_with_budget(lambda: 42, budget_s=1.0, on_timeout=lambda: -1, on_error=lambda e: -2) == 42


def test_run_with_budget_times_out() -> None:
    def _slow() -> int:
        time.sleep(0.3)
        return 1

    assert run_with_budget(_slow, budget_s=0.05, on_timeout=lambda: -1, on_error=lambda e: -2) == -1


def test_run_with_budget_catches_errors() -> None:
    def _boom() -> int:
        raise ValueError("no")

    assert run_with_budget(_boom, budget_s=1.0, on_timeout=lambda: -1, on_error=lambda e: -2) == -2


# ---- IF-24b RPC ----------------------------------------------------------------------------------

def _app(evaluator: Any, *, token: str = "secret") -> FastAPI:
    app = FastAPI()
    app.include_router(build_router(evaluator, authorise=lambda t: t == token))
    return app


def test_rpc_requires_token() -> None:
    client = TestClient(_app(lambda req: evaluate_adhoc(req.to_subject())))
    r = client.post("/rpc/trust/adhoc", json={"name": "Acme"})
    assert r.status_code == 401


def test_rpc_requires_at_least_one_field() -> None:
    client = TestClient(_app(lambda req: evaluate_adhoc(req.to_subject())))
    r = client.post("/rpc/trust/adhoc", json={"country": "GB"}, headers={"x-internal-token": "secret"})
    assert r.status_code == 400


def test_rpc_returns_rollup(monkeypatch: pytest.MonkeyPatch) -> None:
    from .models import RollupResult

    fake = RollupResult(level="medium", rule_version=1, copy_version="1",
                        checks={"sanctions": _outcome("sanctions", "pass")}, computed_at=_now())
    client = TestClient(_app(lambda req: fake))
    r = client.post("/rpc/trust/adhoc", json={"name": "Acme"}, headers={"x-internal-token": "secret"})
    assert r.status_code == 200
    body = r.json()
    assert body["level"] == "medium" and body["ruleVersion"] == 1
    assert body["checks"][0]["id"] == "sanctions"
