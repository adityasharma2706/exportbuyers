"""M12 job and event wiring (M02 IF-02a / IF-02c).

- ``m12.load_wco_hs {version, url, make_current}``          → WcoHsLoader
- ``m12.load_itchs {edition, url, make_current}``           → DgftItcHsLoader
- ``m12.load_correlation {from_version, to_version, url}``  → CorrelationLoader
- EV-12 ``nomenclature.version_loaded {version}`` schema (emitted by the store)

A rejected table (HsLoadError) will not get better on retry, so it goes straight to the dead
letter queue (M11 ``system.dead_letter``) with the problems listed.
"""
from __future__ import annotations

import threading
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict, Field, field_validator

from kp.m01_platform import KpError, get_logger
from kp.m02_queue import JobMeta, NonRetryable, register_event_schema, register_handler, register_rate_class

from .loaders import RATE_CLASS, CorrelationLoader, DgftItcHsLoader, WcoHsLoader, itchs_version
from .models import EV_NOMENCLATURE_VERSION_LOADED, HsLoadError, VERSION_RE, assert_version
from .store import HsStore, PgHsStore

LOAD_WCO_JOB = "m12.load_wco_hs"
LOAD_ITCHS_JOB = "m12.load_itchs"
LOAD_CORRELATION_JOB = "m12.load_correlation"

_log = get_logger("kp.m12_hs.jobs")
_registered = False
_lock = threading.Lock()
_store_factory: Callable[[], HsStore] = PgHsStore


def set_store_factory_for_testing(factory: Callable[[], HsStore] | None) -> None:
    global _store_factory
    _store_factory = factory or PgHsStore


def _url(v: str) -> str:
    if not v.lower().startswith(("http://", "https://")):
        raise ValueError("url must be http(s)")
    return v


class NomenclatureVersionLoaded(BaseModel):
    """EV-12 payload."""
    model_config = ConfigDict(extra="forbid")
    version: str

    @field_validator("version")
    @classmethod
    def _v(cls, v: str) -> str:
        if not VERSION_RE.match(v):
            raise ValueError("invalid nomenclature version")
        return v


class LoadWcoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str
    url: str = Field(max_length=2000)
    make_current: bool = True

    @field_validator("version")
    @classmethod
    def _v(cls, v: str) -> str:
        try:
            return assert_version(v, "HS")
        except KpError as e:
            raise ValueError(str(e)) from e

    @field_validator("url")
    @classmethod
    def _u(cls, v: str) -> str:
        return _url(v)


class LoadItcHsPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    edition: str
    url: str = Field(max_length=2000)
    make_current: bool = True

    @field_validator("edition", mode="before")
    @classmethod
    def _e(cls, v: Any) -> str:
        try:
            return itchs_version(v)
        except KpError as e:
            raise ValueError(str(e)) from e

    @field_validator("url")
    @classmethod
    def _u(cls, v: str) -> str:
        return _url(v)


class LoadCorrelationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_version: str
    to_version: str
    url: str = Field(max_length=2000)

    @field_validator("from_version", "to_version")
    @classmethod
    def _v(cls, v: str) -> str:
        if not VERSION_RE.match(v):
            raise ValueError("invalid nomenclature version")
        return v

    @field_validator("url")
    @classmethod
    def _u(cls, v: str) -> str:
        return _url(v)


def handle_load_wco(p: LoadWcoPayload, meta: JobMeta) -> None:
    try:
        res = WcoHsLoader(p.version).load(p.url, _store_factory(), make_current=p.make_current,
                                          correlation_id=meta.correlation_id)
    except HsLoadError as e:
        raise NonRetryable(f"{e} {e.details}") from e
    _log.info("wco hs loaded", extra={"version": res.version, "codes": res.codes, "warnings": res.warnings[:20]})


def handle_load_itchs(p: LoadItcHsPayload, meta: JobMeta) -> None:
    try:
        res = DgftItcHsLoader(p.edition).load(p.url, _store_factory(), make_current=p.make_current,
                                              correlation_id=meta.correlation_id)
    except HsLoadError as e:
        raise NonRetryable(f"{e} {e.details}") from e
    _log.info("itc-hs loaded", extra={"version": res.version, "codes": res.codes, "warnings": res.warnings[:20]})


def handle_load_correlation(p: LoadCorrelationPayload, meta: JobMeta) -> None:
    try:
        n = CorrelationLoader.for_versions(p.from_version, p.to_version).load(
            p.url, _store_factory(), correlation_id=meta.correlation_id)
    except HsLoadError as e:
        raise NonRetryable(f"{e} {e.details}") from e
    _log.info("hs correlation loaded", extra={"from": p.from_version, "to": p.to_version, "rows": n})


def register_hs_jobs() -> None:
    """Idempotent: registers the loader jobs, the rate class and the EV-12 payload schema."""
    global _registered
    with _lock:
        if _registered:
            return
        register_rate_class(RATE_CLASS, 1, 0.5)  # one file at a time, polite to government hosts [tunable]
        register_event_schema(EV_NOMENCLATURE_VERSION_LOADED, NomenclatureVersionLoaded)
        register_handler(LOAD_WCO_JOB, LoadWcoPayload, handle_load_wco)
        register_handler(LOAD_ITCHS_JOB, LoadItcHsPayload, handle_load_itchs)
        register_handler(LOAD_CORRELATION_JOB, LoadCorrelationPayload, handle_load_correlation)
        _registered = True
