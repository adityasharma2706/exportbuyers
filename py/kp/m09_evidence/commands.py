"""IF-09b: operator and review-outcome commands (job type ``m09.assertion_command``).

Every command is written with source ``operator.manual`` (operator-confirmed facts; user reports
reach the catalogue only after an operator applies them) and carries the review item and actor
in ``source_ref`` so the fact stays traceable (REQ-033).
"""
from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from kp.m01_platform import KpError, get_logger

from .attributes import is_allowed
from .models import AssertionId, AssertionIn, utcnow
from .repo import EvidenceRepo
from .store import EV_SANCTIONS_FLAG_CHANGED, _resolve, _write, merge_companies

_log = get_logger("kp.m09_evidence.commands")

ASSERTION_COMMAND_JOB = "m09.assertion_command"
OPERATOR_SOURCE_ID = "operator.manual"
PRODUCER = "m09.assertion_command"
PRODUCER_VERSION = "1"

CommandKind = Literal["report_not_buyer", "report_closed", "operator_correction", "merge_confirm", "merge_reject",
                      "sanctions_decision"]


class AssertionCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: CommandKind
    subject_id: UUID
    payload: dict[str, Any] = Field(default_factory=dict)
    review_item_id: UUID | None = None
    actor: str = Field(min_length=1, max_length=200)


class CommandResult(BaseModel):
    kind: str
    company_id: str
    assertion_id: AssertionId | None = None


def _ref(cmd: AssertionCommand, **extra: Any) -> dict[str, Any]:
    ref: dict[str, Any] = {"command": cmd.kind, "actor": cmd.actor, "decided_at": utcnow().isoformat()}
    if cmd.review_item_id is not None:
        ref["review_item_id"] = str(cmd.review_item_id)
    ref.update(extra)
    return ref


def _operator_fact(cmd: AssertionCommand, company_id: str, attribute: str, value: dict[str, Any],
                   repo: EvidenceRepo, **ref: Any) -> AssertionId | None:
    a = AssertionIn(subject_id=company_id, attribute=attribute, value=value, source_id=OPERATOR_SOURCE_ID,
                    source_ref=_ref(cmd, **ref), confidence=1.0, producer=PRODUCER,
                    producer_version=PRODUCER_VERSION)
    return _write(a, repo, negation=False)


def _other_id(cmd: AssertionCommand) -> str:
    other = cmd.payload.get("into") or cmd.payload.get("a") or cmd.payload.get("other_id")
    try:
        return str(UUID(str(other)))
    except (TypeError, ValueError) as e:
        raise KpError("VALIDATION", f"{cmd.kind}: payload.into must be the uuid of the other company") from e


def handle_command(cmd: AssertionCommand, repo: EvidenceRepo) -> CommandResult:
    """Applies one command inside the repo's transaction."""
    company = _resolve(repo, str(cmd.subject_id))
    cid = company.id

    if cmd.kind == "report_not_buyer":
        heading = cmd.payload.get("hs_heading")
        aid = _operator_fact(cmd, cid, "not_buyer_for", {"hs_heading": heading}, repo)
        return CommandResult(kind=cmd.kind, company_id=cid, assertion_id=aid)

    if cmd.kind == "report_closed":
        aid = _operator_fact(cmd, cid, "status.closed", {"closed": True}, repo)
        if company.status != "closed":
            repo.update_company(cid, {"status": "closed"})
        return CommandResult(kind=cmd.kind, company_id=cid, assertion_id=aid)

    if cmd.kind == "operator_correction":
        attribute = cmd.payload.get("attribute")
        value = cmd.payload.get("value")
        if not isinstance(attribute, str) or not is_allowed(attribute):
            raise KpError("VALIDATION", "operator_correction: payload.attribute must be an allowed attribute")
        if not isinstance(value, dict):
            raise KpError("VALIDATION", "operator_correction: payload.value must be an object")
        if attribute == "status.closed":
            closed = value.get("closed", True) is not False
            status = "closed" if closed else "active"
            if company.status != status:
                repo.update_company(cid, {"status": status})
        aid = _operator_fact(cmd, cid, attribute, value, repo)
        return CommandResult(kind=cmd.kind, company_id=cid, assertion_id=aid)

    if cmd.kind == "merge_confirm":
        # subject_id is the duplicate (b); payload.into is the company that survives (a).
        keep = _other_id(cmd)
        kept = merge_companies(repo, keep, cid)
        repo.record_merge_decision(kept, str(cmd.subject_id), "merge",
                                   str(cmd.review_item_id) if cmd.review_item_id else None, cmd.actor)
        return CommandResult(kind=cmd.kind, company_id=kept)

    if cmd.kind == "merge_reject":
        other = _resolve(repo, _other_id(cmd)).id
        repo.record_merge_decision(cid, other, "distinct",
                                   str(cmd.review_item_id) if cmd.review_item_id else None, cmd.actor)
        return CommandResult(kind=cmd.kind, company_id=cid)

    if cmd.kind == "sanctions_decision":
        decision = cmd.payload.get("decision")
        if decision not in ("confirmed", "cleared"):
            raise KpError("VALIDATION", "sanctions_decision: payload.decision must be confirmed or cleared")
        block = decision == "confirmed"
        aid = _operator_fact(cmd, cid, "sanctions_flag", {"block": block, "decision": decision}, repo)
        repo.emit(EV_SANCTIONS_FLAG_CHANGED, {"company_id": cid, "block": block})
        return CommandResult(kind=cmd.kind, company_id=cid, assertion_id=aid)

    raise KpError("VALIDATION", f"unknown command {cmd.kind}")  # unreachable: pydantic restricts kind
