"""M25 Freshness and re-verification scheduler — Python public API.

REQ-033 (stale detection and re-check); enabling REQ-034.

- IF-25a ``reverify(assertionIds, trigger, triggerRef) -> [VerifyOutcome]`` — used directly by
  M29 (reveal) and M30 (after a report), and behind ``POST /rpc/reverify`` (``rpc.py``) for the
  serving plane.
- Per kind (LLD M25 "Per kind"): email gets an MX check then the (pluggable, vendor-TBD)
  email-verification vendor; phone/WhatsApp get libphonenumber validity only; website/form get an
  HTTP reachability check.
- Writes: ``invalid`` → ``negate(...)`` (M09) + EV-06 ``contact.invalidated``; ``valid``/``risky`` →
  a refreshed ``checked_at``/``deliverability`` + EV-06 ``contact.verified``; ``unknown`` → no write
  (HLD OQ2: invalid means a negative assertion only, never suppression).
- Nightly schedule (``jobs.py``): ``stale('contact.', 90d, limit=5000)`` → chunked
  ``m25.reverify`` jobs; ``stale('product_evidence', 180d)`` → a re-crawl through M20 for that
  domain.

Other modules import only from here.
"""
from .budget import CHECK_BUDGET_S
from .checks import check_email, check_phone, check_url
from .contact_store import (
    ContactValueSource,
    MemoryContactValues,
    PgContactValues,
    default_contact_value_source,
    set_contact_value_source_for_testing,
)
from .email_vendor import (
    EmailVerifier,
    GenericEmailVerifier,
    default_email_verifier,
    map_vendor_result,
    set_email_verifier_for_testing,
)
from .jobs import (
    NIGHTLY_JOB,
    REVERIFY_JOB,
    handle_nightly,
    handle_reverify,
    register_freshness_jobs,
    request_reverify,
    reset_registration_for_testing,
    set_conn_factory_for_testing,
    set_deps_for_testing,
)
from .models import (
    CONTACT_STALE_DAYS,
    EV_CONTACT_INVALIDATED,
    EV_CONTACT_VERIFIED,
    NIGHTLY_CHUNK_SIZE,
    NIGHTLY_CONTACT_LIMIT,
    NIGHTLY_CRON,
    NIGHTLY_RECRAWL_LIMIT,
    NIGHTLY_SCHEDULE,
    PRODUCER,
    PRODUCER_VERSION,
    RECRAWL_DAYS,
    REVERIFY_RPC_WAIT_MS,
    SOURCE_ID,
    ContactInvalidatedEvent,
    ContactVerifiedEvent,
    DeliverabilityStatus,
    NightlyPayload,
    ReverifyPayload,
    Trigger,
    VerifyOutcome,
    idempotency_key,
)
from .pipeline import ReverifyDeps, reverify, reverify_assertions
from .rpc import build_router, create_app

__all__ = [
    "CHECK_BUDGET_S",
    "CONTACT_STALE_DAYS",
    "EV_CONTACT_INVALIDATED",
    "EV_CONTACT_VERIFIED",
    "NIGHTLY_CHUNK_SIZE",
    "NIGHTLY_CONTACT_LIMIT",
    "NIGHTLY_CRON",
    "NIGHTLY_JOB",
    "NIGHTLY_RECRAWL_LIMIT",
    "NIGHTLY_SCHEDULE",
    "PRODUCER",
    "PRODUCER_VERSION",
    "RECRAWL_DAYS",
    "REVERIFY_JOB",
    "REVERIFY_RPC_WAIT_MS",
    "SOURCE_ID",
    "ContactInvalidatedEvent",
    "ContactValueSource",
    "ContactVerifiedEvent",
    "DeliverabilityStatus",
    "EmailVerifier",
    "GenericEmailVerifier",
    "MemoryContactValues",
    "NightlyPayload",
    "PgContactValues",
    "ReverifyDeps",
    "ReverifyPayload",
    "Trigger",
    "VerifyOutcome",
    "build_router",
    "check_email",
    "check_phone",
    "check_url",
    "create_app",
    "default_contact_value_source",
    "default_email_verifier",
    "handle_nightly",
    "handle_reverify",
    "idempotency_key",
    "map_vendor_result",
    "register_freshness_jobs",
    "request_reverify",
    "reset_registration_for_testing",
    "reverify",
    "reverify_assertions",
    "set_conn_factory_for_testing",
    "set_contact_value_source_for_testing",
    "set_deps_for_testing",
    "set_email_verifier_for_testing",
]
