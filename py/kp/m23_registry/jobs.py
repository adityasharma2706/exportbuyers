"""M23 job wiring (M02): vendor rate classes and the monthly free-mail list refresh.

- Rate classes ``vendor.gleif``, ``vendor.companies_house``, ``vendor.vies``, ``vendor.opencorporates``,
  ``vendor.rdap``, ``vendor.whois``, ``vendor.freemail`` — queued jobs that call a vendor set the
  matching ``rate_class``; on-demand calls take tokens from the same buckets.
- ``m23.freemail_refresh`` — 1st of each month, 02:00 UTC, on the 'knowledge' queue.
"""
from __future__ import annotations

import threading

from pydantic import BaseModel, ConfigDict, Field

from kp.m01_platform import get_logger
from kp.m02_queue import JobMeta, register_handler, register_rate_class, register_schedule

from .freemail import refresh_freemail
from .ratelimit import VENDOR_RATES

FREEMAIL_REFRESH_JOB = "m23.freemail_refresh"
FREEMAIL_SCHEDULE = "m23.freemail-monthly"
MONTHLY_CRON = "0 2 1 * *"
QUEUE = "knowledge"

_log = get_logger("kp.m23_registry.jobs")
_registered = False
_lock = threading.Lock()


class FreemailRefreshPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    upstream_url: str | None = Field(default=None, max_length=2048, pattern=r"^https://")


def handle_freemail_refresh(p: FreemailRefreshPayload, meta: JobMeta) -> None:
    n = refresh_freemail(p.upstream_url)
    _log.info("free-mail refresh job done", extra={"entries": n, "job_id": meta.job_id})


def register_registry_jobs() -> None:
    """Idempotent."""
    global _registered
    with _lock:
        if _registered:
            return
        for rate in VENDOR_RATES.values():
            register_rate_class(rate.rate_class, rate.max_concurrency, rate.per_second)
        register_handler(FREEMAIL_REFRESH_JOB, FreemailRefreshPayload, handle_freemail_refresh)
        register_schedule(FREEMAIL_SCHEDULE, MONTHLY_CRON, FREEMAIL_REFRESH_JOB, {}, QUEUE)
        _registered = True


def reset_registration_for_testing() -> None:
    global _registered
    _registered = False
