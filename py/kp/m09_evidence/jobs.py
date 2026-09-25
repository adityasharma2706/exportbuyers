"""M09 job and event wiring (M02 IF-02a / IF-02c).

- ``m09.project {company_id}``            → rebuild the read models of one company
- ``m09.assertion_command``               → IF-09b (AssertionCommand)
- EV-01 ``entity.changed``                → debounced ``m09.project`` (60 s, keyed by company)
- EV-03 ``sanctions.flag_changed``        → debounced ``m09.project``
- EV-04 ``suppression.added {hashes}``    → purge the docs and contact values that carry the
                                             hashes now, then rebuild the affected companies
"""
from __future__ import annotations

import re
import threading
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from kp.m01_platform import get_logger
from kp.m02_queue import (
    EventMeta,
    JobMeta,
    NonRetryable,
    register_event_schema,
    register_handler,
    subscribe,
)

from .commands import ASSERTION_COMMAND_JOB, AssertionCommand, handle_command
from .models import CompanyNotFound
from .projection import project_company
from .repo import EvidenceRepo
from .store import (
    EV_ENTITY_CHANGED,
    EV_SANCTIONS_FLAG_CHANGED,
    EV_SUPPRESSION_ADDED,
    as_repo,
    open_repo,
)

_log = get_logger("kp.m09_evidence.jobs")

PROJECT_JOB = "m09.project"
PROJECT_DEBOUNCE = timedelta(seconds=60)  # [tunable]
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class ProjectPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    company_id: UUID


class EntityChanged(BaseModel):
    """EV-01 payload."""
    model_config = ConfigDict(extra="ignore")
    company_id: UUID
    attribute_classes: list[str] = Field(default_factory=list)


class SanctionsFlagChanged(BaseModel):
    """EV-03 payload (company-level)."""
    model_config = ConfigDict(extra="ignore")
    company_id: UUID
    block: bool | None = None


class SuppressionAdded(BaseModel):
    """EV-04 payload."""
    model_config = ConfigDict(extra="ignore")
    hashes: list[str]

    @field_validator("hashes")
    @classmethod
    def _hashes(cls, v: list[str]) -> list[str]:
        if not all(isinstance(h, str) and _HASH_RE.match(h) for h in v):
            raise ValueError("hashes must be lower-case sha256 hex digests")
        return v


def enqueue_projection(repo: EvidenceRepo, company_id: str, *, now: datetime | None = None,
                       debounce: bool = True, key_suffix: str | None = None) -> str:
    """Enqueues ``m09.project`` for a company. Debounced: one job per company per 60 s window,
    run 60 s after the first change in that window (so later changes in it are picked up)."""
    t = now or datetime.now(timezone.utc)
    if debounce:
        bucket = int(t.timestamp() // PROJECT_DEBOUNCE.total_seconds())
        key = f"{company_id}:{bucket}"
        run_at: datetime | None = t + PROJECT_DEBOUNCE
    else:
        key = f"{company_id}:now:{key_suffix or int(t.timestamp() * 1000)}"
        run_at = None
    return repo.enqueue(PROJECT_JOB, {"company_id": str(company_id)}, key, run_at)


# ---- handlers --------------------------------------------------------------------------------

def run_project_job(data: ProjectPayload, meta: JobMeta | None = None, *, tx: Any = None) -> None:
    with open_repo(tx) as repo:
        project_company(repo, str(data.company_id))


def run_assertion_command(cmd: AssertionCommand, meta: JobMeta | None = None, *, tx: Any = None) -> None:
    try:
        with open_repo(tx) as repo:
            res = handle_command(cmd, repo)
            enqueue_projection(repo, res.company_id)
    except CompanyNotFound as e:
        raise NonRetryable(str(e)) from e
    _log.info("assertion command applied", extra={"kind": cmd.kind, "company_id": str(cmd.subject_id)})


def on_entity_changed(payload: Any, meta: EventMeta) -> None:
    ev = EntityChanged.model_validate(payload)
    enqueue_projection(as_repo(meta.tx), str(ev.company_id))


def on_sanctions_changed(payload: Any, meta: EventMeta) -> None:
    ev = SanctionsFlagChanged.model_validate(payload)
    # A block must show without waiting for the debounce window.
    enqueue_projection(as_repo(meta.tx), str(ev.company_id), debounce=False, key_suffix=meta.event_id)


def purge_for_suppression(repo: EvidenceRepo, hashes: list[str], *, event_id: str | None = None) -> list[str]:
    """Deletes the docs of every company carrying one of ``hashes`` and the matching contact
    values, then enqueues an immediate rebuild (which leaves the suppressed facts out)."""
    hs = list(dict.fromkeys(hashes))
    if not hs:
        return []
    companies = repo.companies_for_hashes(hs)
    companies.extend(c for c in repo.purge_contact_values(hs) if c not in companies)
    for cid in companies:
        repo.delete_search_docs(cid)
        repo.delete_profile_doc(cid)
        enqueue_projection(repo, cid, debounce=False, key_suffix=event_id)
    return companies


def on_suppression_added(payload: Any, meta: EventMeta) -> None:
    ev = SuppressionAdded.model_validate(payload)
    purged = purge_for_suppression(as_repo(meta.tx), ev.hashes, event_id=meta.event_id)
    _log.info("read models purged for suppression", extra={"companies": len(purged)})


_registered = False
_reg_lock = threading.Lock()


def register_evidence_jobs() -> None:
    """Registers M09's handlers and subscriptions with M02 (idempotent within a process)."""
    global _registered
    with _reg_lock:
        if _registered:
            return
        register_event_schema(EV_ENTITY_CHANGED, EntityChanged)
        register_handler(PROJECT_JOB, ProjectPayload, lambda d, m: run_project_job(d, m))
        register_handler(ASSERTION_COMMAND_JOB, AssertionCommand, lambda d, m: run_assertion_command(d, m))
        subscribe(EV_ENTITY_CHANGED, "m09.project", on_entity_changed)
        subscribe(EV_SANCTIONS_FLAG_CHANGED, "m09.project", on_sanctions_changed)
        subscribe(EV_SUPPRESSION_ADDED, "m09.purge", on_suppression_added)
        _registered = True


def reset_registration_for_testing() -> None:
    global _registered
    with _reg_lock:
        _registered = False
