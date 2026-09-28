"""M25 unit tests: per-kind checks, the vendor-result mapping, the end-to-end write path over
M09's in-memory repo, nightly chunking and the ``/rpc/reverify`` RPC. No test opens a real socket
or a real database connection."""
from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import httpx
import phonenumbers
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kp.m08_sources import register_entries_loader, set_source_loader_for_testing, validate_entry
from kp.m09_evidence import (
    AssertionIn,
    MemoryEvidenceRepo,
    contact_value_hash,
    create_company,
    get_assertions,
    set_suppression_checker,
    write_assertion,
)
from kp.m22_enrichment import MxResult
from kp.m25_freshness import (
    ContactInvalidatedEvent,
    ContactVerifiedEvent,
    EV_CONTACT_INVALIDATED,
    EV_CONTACT_VERIFIED,
    MemoryContactValues,
    ReverifyDeps,
    VerifyOutcome,
    check_email,
    check_phone,
    check_url,
    idempotency_key,
    map_vendor_result,
    reverify_assertions,
    set_email_verifier_for_testing,
)
from kp.m25_freshness.jobs import request_reverify
from kp.m25_freshness.rpc import ReverifyRequest, build_router

T0 = datetime(2026, 9, 28, 10, 0, tzinfo=timezone.utc)


def _sources() -> list[Any]:
    return [
        validate_entry({"id": "web.crawl", "source_type": "website", "can_store": True, "can_display": True,
                        "can_export": True, "retention_days": 365, "attribution_text": "Source: website",
                        "personal_data_class": "business_contact", "allowed_regions": ["*"], "status": "active"}),
        validate_entry({"id": "freshness.reverify", "source_type": "operator", "can_store": False,
                        "can_display": True, "can_export": True, "retention_days": None,
                        "attribution_text": "Our own automated re-verification",
                        "personal_data_class": "business_contact", "allowed_regions": ["*"], "status": "active"}),
    ]


@pytest.fixture(autouse=True)
def _register_sources() -> Iterable[None]:
    set_source_loader_for_testing(register_entries_loader(_sources()))
    set_suppression_checker(None)
    yield
    set_source_loader_for_testing(None)
    set_suppression_checker(None)


class FakeDns:
    def __init__(self, has_mx: bool | None) -> None:
        self.has_mx = has_mx
        self.calls: list[str] = []

    def mx_lookup(self, domain: str) -> MxResult:
        self.calls.append(domain)
        return MxResult(domain=domain, has_mx=self.has_mx)

    def domain_resolves(self, domain: str) -> bool | None:
        return True


class FakeVendor:
    def __init__(self, result: str | None = "deliverable", raises: bool = False) -> None:
        self.result = result
        self.raises = raises
        self.calls: list[str] = []

    def verify(self, email: str) -> Any:
        self.calls.append(email)
        if self.raises:
            raise RuntimeError("vendor down")
        return map_vendor_result(self.result)


# ---- per-kind checks ------------------------------------------------------------------------------

def _valid_de_e164() -> str:
    """A genuine phonenumbers example number for DE, guaranteed to pass is_valid_number()."""
    return phonenumbers.format_number(phonenumbers.example_number("DE"), phonenumbers.PhoneNumberFormat.E164)


def test_check_phone_valid_and_invalid() -> None:
    assert check_phone(_valid_de_e164(), "phone") == "valid"
    assert check_phone("+1234", "phone") == "invalid"
    assert check_phone("not-a-number", "phone") == "invalid"


def test_check_phone_whatsapp_url() -> None:
    good = _valid_de_e164()
    assert check_phone(f"https://wa.me/{good[1:]}", "whatsapp") == "valid"
    assert check_phone("https://wa.me/12", "whatsapp") == "invalid"


def test_check_email_no_mx_short_circuits_vendor() -> None:
    dns = FakeDns(has_mx=False)
    vendor = FakeVendor()
    assert check_email("sales@acme.de", dns, vendor) == "invalid"
    assert vendor.calls == []   # never called: confirmed no MX is enough


def test_check_email_vendor_mapping() -> None:
    dns = FakeDns(has_mx=True)
    assert check_email("sales@acme.de", dns, FakeVendor("deliverable")) == "valid"
    assert check_email("sales@acme.de", dns, FakeVendor("catch-all")) == "risky"
    assert check_email("sales@acme.de", dns, FakeVendor("undeliverable")) == "invalid"
    assert check_email("sales@acme.de", dns, FakeVendor("error")) == "unknown"
    assert check_email("sales@acme.de", dns, FakeVendor(raises=True)) == "unknown"


def test_check_email_unknown_mx_still_asks_the_vendor() -> None:
    dns = FakeDns(has_mx=None)   # the MX lookup itself failed
    vendor = FakeVendor("deliverable")
    assert check_email("sales@acme.de", dns, vendor) == "valid"
    assert vendor.calls == ["sales@acme.de"]


def test_map_vendor_result_covers_the_vocabulary() -> None:
    assert map_vendor_result("Deliverable") == "valid"
    assert map_vendor_result("CATCH_ALL") == "risky"
    assert map_vendor_result("Undeliverable") == "invalid"
    assert map_vendor_result(None) == "unknown"
    assert map_vendor_result("something-else") == "unknown"


def test_default_email_verifier_without_secrets_is_unknown() -> None:
    from kp.m25_freshness import default_email_verifier

    set_email_verifier_for_testing(None)
    try:
        assert default_email_verifier().verify("sales@acme.de") == "unknown"
    finally:
        set_email_verifier_for_testing(None)


def test_check_url_status_mapping() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "404" in str(request.url):
            return httpx.Response(404)
        if "500" in str(request.url):
            return httpx.Response(500)
        return httpx.Response(200)

    transport = httpx.MockTransport(handler)
    assert check_url("https://acme.de/", transport=transport) == "valid"
    assert check_url("https://acme.de/404", transport=transport) == "invalid"
    assert check_url("https://acme.de/500", transport=transport) == "unknown"


def test_check_url_connect_error_without_dns_cause_is_unknown() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    transport = httpx.MockTransport(handler)
    assert check_url("https://acme.de/", transport=transport) == "unknown"


# ---- idempotency ----------------------------------------------------------------------------------

def test_idempotency_key() -> None:
    assert idempotency_key("schedule", "nightly:2026-09-28", 3) == "reverify:schedule:nightly:2026-09-28:3"


# ---- reverify_assertions over M09's in-memory repo -------------------------------------------------

def _company_and_contact(repo: MemoryEvidenceRepo, kind: str, value: str, deliverability: str | None = None) -> Any:
    cid = create_company(repo, display_name="Acme Trading GmbH", country="DE", primary_domain="acme.de")
    value_hash = contact_value_hash(kind, value)
    val: dict[str, Any] = {"value_hash": value_hash, "display_mask": "s***@acme.de"}
    if deliverability:
        val["deliverability"] = deliverability
    aid = write_assertion(AssertionIn(
        subject_id=cid, attribute=f"contact.{kind}", value=val, source_id="web.crawl",
        source_ref={"url": "https://acme.de/kontakt", "captured_at": T0.isoformat()},
        observed_at=T0, checked_at=T0, confidence=0.9, personal_data_class="business_contact",
        producer="m22", producer_version="enrich-v1",
    ), tx=repo)
    assert aid is not None
    return cid, str(aid), value_hash


def test_reverify_email_valid_refreshes_checked_at_and_emits_ev06() -> None:
    repo = MemoryEvidenceRepo()
    _cid, aid, _vh = _company_and_contact(repo, "role_email", "sales@acme.de")
    deps = ReverifyDeps(tx=lambda: nullcontext(repo), dns=FakeDns(has_mx=True),
                        email_verifier=FakeVendor("deliverable"), contact_values=MemoryContactValues({aid: "sales@acme.de"}),
                        now=lambda: T0 + timedelta(days=91))
    outcomes = reverify_assertions([aid], "schedule", "test-ref", deps, wait_s=None)
    assert outcomes == [VerifyOutcome(aid, "valid", T0 + timedelta(days=91))]
    active = get_assertions(_cid, ["contact.role_email"], tx=repo)
    assert len(active) == 1 and active[0].value["deliverability"] == "valid"
    assert active[0].checked_at == T0 + timedelta(days=91)
    kinds = [t for t, _ in repo.events]
    assert EV_CONTACT_VERIFIED in kinds
    ev = next(p for t, p in repo.events if t == EV_CONTACT_VERIFIED)
    ContactVerifiedEvent.model_validate(ev)   # schema round-trips


def test_reverify_email_invalid_negates_and_emits_ev06() -> None:
    repo = MemoryEvidenceRepo()
    cid, aid, vh = _company_and_contact(repo, "role_email", "sales@acme.de")
    deps = ReverifyDeps(tx=lambda: nullcontext(repo), dns=FakeDns(has_mx=False), email_verifier=FakeVendor(),
                        contact_values=MemoryContactValues({aid: "sales@acme.de"}), now=lambda: T0 + timedelta(days=91))
    outcomes = reverify_assertions([aid], "reveal", "reveal-1", deps, wait_s=None)
    assert outcomes[0].status == "invalid"
    # HLD OQ2: a negation does not suppress the positive fact; both stay active, and it is up to
    # the display/policy layer to reconcile them.
    active = get_assertions(cid, ["contact.role_email"], tx=repo)
    assert sorted(a.polarity for a in active) == ["negative", "positive"]
    neg = next(a for a in active if a.polarity == "negative")
    assert neg.value.get("value_hash") == vh
    kinds = [t for t, _ in repo.events]
    assert EV_CONTACT_INVALIDATED in kinds
    ev = next(p for t, p in repo.events if t == EV_CONTACT_INVALIDATED)
    ContactInvalidatedEvent.model_validate(ev)


def test_reverify_unknown_writes_nothing() -> None:
    repo = MemoryEvidenceRepo()
    cid, aid, _vh = _company_and_contact(repo, "role_email", "sales@acme.de")
    before = len(repo.assertions)
    deps = ReverifyDeps(tx=lambda: nullcontext(repo), dns=FakeDns(has_mx=True), email_verifier=FakeVendor("error"),
                        contact_values=MemoryContactValues({aid: "sales@acme.de"}), now=lambda: T0 + timedelta(days=91))
    outcomes = reverify_assertions([aid], "schedule", "test-ref", deps, wait_s=None)
    assert outcomes[0].status == "unknown"
    assert len(repo.assertions) == before   # LLD M25: "unknown -> no write"
    assert repo.events == []


def test_reverify_missing_contact_value_is_unknown() -> None:
    repo = MemoryEvidenceRepo()
    _cid, aid, _vh = _company_and_contact(repo, "role_email", "sales@acme.de")
    deps = ReverifyDeps(tx=lambda: nullcontext(repo), contact_values=MemoryContactValues({}), now=lambda: T0)
    outcomes = reverify_assertions([aid], "schedule", "test-ref", deps, wait_s=None)
    assert outcomes == [VerifyOutcome(aid, "unknown", T0)]


def test_reverify_skips_non_contact_and_superseded_assertions() -> None:
    repo = MemoryEvidenceRepo()
    cid = create_company(repo, display_name="Acme", country="DE")
    buyer_type_id = write_assertion(AssertionIn(
        subject_id=cid, attribute="buyer_type", value={"type": "importer"}, source_id="web.crawl",
        source_ref={"url": "https://acme.de/", "captured_at": T0.isoformat()}, confidence=0.8,
        producer="m20", producer_version="1",
    ), tx=repo)
    vh = contact_value_hash("role_email", "sales@acme.de")
    ref = {"url": "https://acme.de/kontakt", "captured_at": T0.isoformat()}
    first_id = write_assertion(AssertionIn(
        subject_id=cid, attribute="contact.role_email", value={"value_hash": vh, "display_mask": "s***@acme.de"},
        source_id="web.crawl", source_ref=ref, confidence=0.9, producer="m22", producer_version="1",
    ), tx=repo)
    second_id = write_assertion(AssertionIn(
        subject_id=cid, attribute="contact.role_email", value={"value_hash": vh, "display_mask": "sa**@acme.de"},
        source_id="web.crawl", source_ref=ref, confidence=0.9, producer="m22", producer_version="1",
    ), tx=repo)
    assert first_id != second_id   # first_id is now superseded by second_id

    deps = ReverifyDeps(tx=lambda: nullcontext(repo), now=lambda: T0)
    outcomes = reverify_assertions(
        [str(buyer_type_id), str(first_id), "00000000-0000-0000-0000-000000000000"], "schedule", "ref", deps,
        wait_s=None,
    )
    assert all(o.status == "unknown" for o in outcomes)


def test_reverify_rejects_unknown_trigger() -> None:
    with pytest.raises(Exception):
        reverify_assertions(["x"], "bogus", "ref")  # type: ignore[arg-type]


# ---- nightly chunking (request_reverify over a fake Tx) --------------------------------------------

class _FakeCursor:
    def __init__(self, row: tuple[Any, ...] | None) -> None:
        self._row = row

    def fetchone(self) -> tuple[Any, ...] | None:
        return self._row


class _FakeTx:
    """Just enough of the M02 ``platform.job`` upsert to exercise ``request_reverify``'s chunking."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], str] = {}
        self.inserts = 0

    def execute(self, query: str, params: Any = ()) -> _FakeCursor:
        q = query.strip().lower()
        if q.startswith("insert into platform.job"):
            self.inserts += 1
            job_id, _queue, type_, _payload, _v, idem, *_rest = params
            key = (type_, idem)
            if key in self.rows:
                return _FakeCursor(None)
            self.rows[key] = job_id
            return _FakeCursor((job_id,))
        if q.startswith("select id from platform.job"):
            type_, idem = params
            row = self.rows.get((type_, idem))
            return _FakeCursor((row,) if row else None)
        raise AssertionError(f"unexpected query in _FakeTx: {query}")


def test_request_reverify_chunks_large_batches() -> None:
    tx = _FakeTx()
    ids = [f"00000000-0000-0000-0000-{i:012d}" for i in range(450)]
    job_ids = request_reverify(tx, ids, "schedule", "nightly:2026-09-28", chunk_size=200)
    assert len(job_ids) == 3   # 200 + 200 + 50
    assert tx.inserts == 3


def test_request_reverify_is_idempotent_per_ref() -> None:
    tx = _FakeTx()
    ids = ["00000000-0000-0000-0000-000000000001"]
    first = request_reverify(tx, ids, "schedule", "nightly:2026-09-28", chunk_size=200)
    second = request_reverify(tx, ids, "schedule", "nightly:2026-09-28", chunk_size=200)
    assert first == second
    assert tx.inserts == 1   # the second call hit the same idempotency key


# ---- RPC ------------------------------------------------------------------------------------------

def _app(reverifier: Any, *, token: str = "secret") -> FastAPI:
    app = FastAPI()
    app.include_router(build_router(reverifier, authorise=lambda t: t == token))
    return app


def test_rpc_requires_token() -> None:
    client = TestClient(_app(lambda ids, trigger, ref: []))
    r = client.post("/rpc/reverify", json={"assertionIds": ["a"], "trigger": "reveal", "triggerRef": "r1"})
    assert r.status_code == 401


def test_rpc_validates_trigger() -> None:
    client = TestClient(_app(lambda ids, trigger, ref: []))
    r = client.post("/rpc/reverify", json={"assertionIds": ["a"], "trigger": "bogus", "triggerRef": "r1"},
                    headers={"x-internal-token": "secret"})
    assert r.status_code == 400


def test_rpc_returns_outcomes() -> None:
    fake_outcomes = [VerifyOutcome("a1", "valid", T0), VerifyOutcome("a2", "unknown", T0)]
    client = TestClient(_app(lambda ids, trigger, ref: fake_outcomes))
    r = client.post("/rpc/reverify", json={"assertionIds": ["a1", "a2"], "trigger": "reveal", "triggerRef": "rv-1"},
                    headers={"x-internal-token": "secret"})
    assert r.status_code == 200
    body = r.json()
    assert body["outcomes"] == [o.to_dict() for o in fake_outcomes]


def test_reverify_request_model_round_trips() -> None:
    req = ReverifyRequest.model_validate({"assertionIds": ["a1"], "trigger": "report", "triggerRef": "rep-1"})
    assert req.trigger == "report" and req.trigger_ref == "rep-1"
