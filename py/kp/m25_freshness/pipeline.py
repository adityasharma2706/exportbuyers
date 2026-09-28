"""M25 IF-25a: ``reverify`` and the underlying per-assertion checks (LLD M25 "API" / "Per kind" /
"Writes").

- Loads each assertion, dispatches it to the check for its contact kind (``checks.py``), and
  writes the result through M09: ``invalid`` negates the fact, ``valid``/``risky`` refresh
  ``checked_at`` and ``deliverability`` (M09 supersedes only when the value actually changed), and
  ``unknown`` writes nothing (LLD: "unknown → no write").
- Every check runs on the shared pool (``budget.py``). ``reverify`` (used by M29's reveal and
  M30's post-report path) waits at most ``REVERIFY_RPC_WAIT_MS``; whatever has not finished by then
  is reported ``unknown`` while its check keeps running and still writes when it completes. The
  nightly path (``jobs.py``) calls ``reverify_assertions`` with no wait — it already runs inside a
  queued job, so blocking to completion there is simply how that job finishes.
"""
from __future__ import annotations

from concurrent.futures import Future
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from kp.m01_platform import KpError, get_logger, span
from kp.m09_evidence import (
    Assertion,
    AssertionIn,
    CONTACT_ATTRIBUTES,
    EvidenceRepo,
    negate,
    open_repo,
    write_assertion,
)
from kp.m22_enrichment import DnsChecker, default_dns_checker

from .budget import result_or, submit, wait_all
from .checks import check_email, check_phone, check_url
from .contact_store import ContactValueSource, default_contact_value_source
from .email_vendor import EmailVerifier, default_email_verifier
from .models import (
    EV_CONTACT_INVALIDATED,
    EV_CONTACT_VERIFIED,
    PRODUCER,
    PRODUCER_VERSION,
    REVERIFY_RPC_WAIT_MS,
    SOURCE_ID,
    TRIGGERS,
    DeliverabilityStatus,
    Trigger,
    VerifyOutcome,
)

_log = get_logger("kp.m25_freshness.pipeline")

TxFactory = Callable[[], AbstractContextManager[Any]]


@dataclass
class ReverifyDeps:
    tx: TxFactory | None = None
    dns: DnsChecker | None = None
    email_verifier: EmailVerifier | None = None
    contact_values: ContactValueSource | None = None
    now: Callable[[], datetime] | None = None

    def open_tx(self) -> AbstractContextManager[Any]:
        return self.tx() if self.tx is not None else open_repo()

    def get_dns(self) -> DnsChecker:
        return self.dns or default_dns_checker()

    def get_email_verifier(self) -> EmailVerifier:
        return self.email_verifier or default_email_verifier()

    def get_contact_values(self) -> ContactValueSource:
        return self.contact_values or default_contact_value_source()

    def utcnow(self) -> datetime:
        return (self.now or (lambda: datetime.now(timezone.utc)))()


def _check_value(kind: str, raw: str, deps: ReverifyDeps) -> DeliverabilityStatus:
    if kind == "role_email":
        return check_email(raw, deps.get_dns(), deps.get_email_verifier())
    if kind in ("phone", "whatsapp"):
        return check_phone(raw, kind)
    if kind in ("website", "form_url"):
        return check_url(raw)
    return "unknown"   # 'address': LLD M25 defines no re-verification method for it


def _write_outcome(deps: ReverifyDeps, a: Assertion, kind: str, status: DeliverabilityStatus, trigger: Trigger,
                   trigger_ref: str, now: datetime) -> None:
    value_hash = a.value.get("value_hash")
    source_ref = {"method": f"m25.reverify:{kind}", "trigger": trigger, "triggerRef": trigger_ref,
                  "capturedAt": now.isoformat()}
    with deps.open_tx() as tx:
        repo: EvidenceRepo = tx  # open_repo() always yields an EvidenceRepo (Pg or Memory)
        if status == "invalid":
            negate(a.subject_id, a.attribute, {"value_hash": value_hash}, SOURCE_ID, source_ref, tx=repo,
                  confidence=1.0, observed_at=now, producer=PRODUCER, producer_version=PRODUCER_VERSION)
            repo.emit(EV_CONTACT_INVALIDATED, {"assertionId": a.id, "companyId": a.subject_id, "kind": kind,
                                               "trigger": trigger, "triggerRef": trigger_ref})
        else:
            new_value: dict[str, Any] = {"value_hash": value_hash, "deliverability": status}
            if a.value.get("display_mask"):
                new_value["display_mask"] = a.value["display_mask"]
            write_assertion(AssertionIn(
                subject_id=a.subject_id, attribute=a.attribute, value=new_value, polarity="positive",
                source_id=SOURCE_ID, source_ref=source_ref, observed_at=now, checked_at=now, confidence=1.0,
                personal_data_class="business_contact", region=a.region, producer=PRODUCER,
                producer_version=PRODUCER_VERSION,
            ), tx=repo)
            repo.emit(EV_CONTACT_VERIFIED, {"assertionId": a.id, "companyId": a.subject_id, "kind": kind,
                                            "status": status, "trigger": trigger, "triggerRef": trigger_ref})


def _reverify_one(deps: ReverifyDeps, a: Assertion, trigger: Trigger, trigger_ref: str, now: datetime) -> VerifyOutcome:
    kind = a.attribute.split(".", 1)[1]
    raw = deps.get_contact_values().get(a.id)
    if raw is None:
        return VerifyOutcome(a.id, "unknown", now)
    status = _check_value(kind, raw, deps)
    if status == "unknown":
        return VerifyOutcome(a.id, "unknown", now)
    _write_outcome(deps, a, kind, status, trigger, trigger_ref, now)
    return VerifyOutcome(a.id, status, now)


def reverify_assertions(assertion_ids: list[Any], trigger: Trigger, trigger_ref: str,
                        deps: ReverifyDeps | None = None, *, wait_s: float | None = None) -> list[VerifyOutcome]:
    """Runs the per-kind check (and the resulting write) for every assertion, on the shared pool.

    ``wait_s=None`` blocks until every check has finished (the nightly job's own execution *is*
    that wait). A finite ``wait_s`` returns after that many seconds with ``'unknown'`` for whatever
    has not finished; those checks keep running and still write when they complete.
    """
    if trigger not in TRIGGERS:
        raise KpError("VALIDATION", f'Unknown trigger "{trigger}"; expected one of {", ".join(TRIGGERS)}')
    if not isinstance(trigger_ref, str) or not trigger_ref.strip():
        raise KpError("VALIDATION", "trigger_ref is required")
    d = deps or ReverifyDeps()
    now = d.utcnow()
    ids = list(dict.fromkeys(str(i) for i in assertion_ids))
    if not ids:
        return []
    with d.open_tx() as tx:
        repo: EvidenceRepo = tx
        loaded = {i: repo.get_assertion(i) for i in ids}
    futures: dict[str, Future[VerifyOutcome]] = {}
    for i in ids:
        a = loaded.get(i)
        if a is None or a.superseded_by is not None or a.attribute not in CONTACT_ATTRIBUTES:
            continue
        futures[i] = submit(lambda a=a: _reverify_one(d, a, trigger, trigger_ref, now))
    outcomes: dict[str, VerifyOutcome] = {}
    if futures:
        done, _pending = wait_all(futures.values(), timeout_s=wait_s)
        for i, fut in futures.items():
            if fut in done:
                outcomes[i] = result_or(fut, on_error=lambda _e, i=i: VerifyOutcome(i, "unknown", now))
            else:
                _log.info("re-verification did not finish within the wait budget; it continues in the background",
                          extra={"assertion_id": i, "trigger": trigger, "trigger_ref": trigger_ref})
                outcomes[i] = VerifyOutcome(i, "unknown", now)
    return [outcomes.get(i, VerifyOutcome(i, "unknown", now)) for i in ids]


def reverify(assertion_ids: list[Any], trigger: Trigger, trigger_ref: str, *,
            deps: ReverifyDeps | None = None) -> list[VerifyOutcome]:
    """IF-25a. Used directly by M29 (reveal) and M30 (after a report), and behind the
    ``POST /rpc/reverify`` endpoint (``rpc.py``) when the caller is the serving plane (TS)."""
    wait_s = REVERIFY_RPC_WAIT_MS / 1000.0 if trigger in ("reveal", "report") else None
    with span("m25.reverify", {"trigger": trigger, "trigger_ref": trigger_ref, "count": len(assertion_ids)}):
        return reverify_assertions(assertion_ids, trigger, trigger_ref, deps, wait_s=wait_s)


__all__ = ["ReverifyDeps", "reverify", "reverify_assertions"]
