"""M09 Evidence store — assertion model and projections (Python public API).

REQ-017, REQ-024 (source type and confidence), REQ-033 (source and last-checked for every
fact); enabling REQ-021 and REQ-032.

- IF-09a ``write_assertion`` / ``negate``: provenance-carrying facts with inherited licence flags,
  suppression check, supersede-with-history and EV-01 in the caller's transaction.
- IF-09b ``AssertionCommand`` (job ``m09.assertion_command``).
- IF-09c ``get_assertions``, ``find_by_anchor``, ``stale``, ``resolve_company_id``.
- Canonical companies: ``create_company``, ``add_anchor``, ``update_company``.
- Projection builder: ``build_projection`` / ``project_company`` (job ``m09.project``).

``named_person`` exists in the model but is disabled: such writes raise PersonalDataDisabled.
Other knowledge-plane modules import only from here.
"""
from kp.m08_sources import SourceNotActive, SourceNotRegistered

from .attributes import (
    CONTACT_ATTRIBUTES,
    CONTACT_KINDS,
    FIXED_ATTRIBUTES,
    InvalidAttribute,
    attribute_class,
    identity_key,
    is_allowed,
    validate_value,
)
from .commands import ASSERTION_COMMAND_JOB, AssertionCommand, CommandResult, handle_command
from .jobs import (
    PROJECT_JOB,
    EntityChanged,
    ProjectPayload,
    SanctionsFlagChanged,
    SuppressionAdded,
    enqueue_projection,
    purge_for_suppression,
    register_evidence_jobs,
    reset_registration_for_testing,
    run_assertion_command,
    run_project_job,
)
from .models import (
    ANCHOR_KINDS,
    AnchorConflict,
    Assertion,
    AssertionId,
    AssertionIn,
    Company,
    CompanyId,
    CompanyNotFound,
    ContactValue,
    MergeCycle,
    MissingPageReference,
    PersonalDataDisabled,
)
from .norm import (
    contact_value_hash,
    norm_hash,
    normalise,
    set_norm_hash,
    set_suppression_checker,
    value_identifier_hashes,
)
from .projection import (
    COMPETITOR_ORIGINS,
    PROJECTION_VERSION,
    ProjectionResult,
    build_projection,
    project_company,
)
from .repo import EvidenceRepo, MemoryEvidenceRepo, PgEvidenceRepo
from .store import (
    EV_ENTITY_CHANGED,
    EV_SANCTIONS_FLAG_CHANGED,
    EV_SUPPRESSION_ADDED,
    add_anchor,
    counters,
    create_company,
    find_by_anchor,
    get_assertions,
    get_company,
    merge_companies,
    negate,
    normalise_anchor,
    open_repo,
    put_contact_value,
    resolve_company_id,
    set_connection_factory,
    stale,
    update_company,
    write_assertion,
)

__all__ = [
    "ANCHOR_KINDS",
    "ASSERTION_COMMAND_JOB",
    "COMPETITOR_ORIGINS",
    "CONTACT_ATTRIBUTES",
    "CONTACT_KINDS",
    "EV_ENTITY_CHANGED",
    "EV_SANCTIONS_FLAG_CHANGED",
    "EV_SUPPRESSION_ADDED",
    "FIXED_ATTRIBUTES",
    "PROJECTION_VERSION",
    "PROJECT_JOB",
    "AnchorConflict",
    "Assertion",
    "AssertionCommand",
    "AssertionId",
    "AssertionIn",
    "CommandResult",
    "Company",
    "CompanyId",
    "CompanyNotFound",
    "ContactValue",
    "EntityChanged",
    "EvidenceRepo",
    "InvalidAttribute",
    "MemoryEvidenceRepo",
    "MergeCycle",
    "MissingPageReference",
    "PersonalDataDisabled",
    "PgEvidenceRepo",
    "ProjectPayload",
    "ProjectionResult",
    "SanctionsFlagChanged",
    "SourceNotActive",
    "SourceNotRegistered",
    "SuppressionAdded",
    "add_anchor",
    "attribute_class",
    "build_projection",
    "contact_value_hash",
    "counters",
    "create_company",
    "enqueue_projection",
    "find_by_anchor",
    "get_assertions",
    "get_company",
    "handle_command",
    "identity_key",
    "is_allowed",
    "merge_companies",
    "negate",
    "norm_hash",
    "normalise",
    "normalise_anchor",
    "open_repo",
    "project_company",
    "purge_for_suppression",
    "put_contact_value",
    "register_evidence_jobs",
    "reset_registration_for_testing",
    "resolve_company_id",
    "run_assertion_command",
    "run_project_job",
    "set_connection_factory",
    "set_norm_hash",
    "set_suppression_checker",
    "stale",
    "update_company",
    "validate_value",
    "value_identifier_hashes",
    "write_assertion",
]
