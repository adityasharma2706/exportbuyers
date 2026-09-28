"""IF-24b: the ad hoc trust-check RPC for the serving plane (M32 "Check a buyer").

    POST /rpc/trust/adhoc   {name?, email?, website?, country?}
      → 200 TrustResultDto (DS-08)   {level, ruleVersion, copyVersion, computedAt, checks: [...]}
      → 400 VALIDATION, 401 UNAUTHENTICATED, 503 UPSTREAM_UNAVAILABLE (never — see below)

At least one of ``name``, ``email`` or ``website`` is required. The overall server budget is 8 s
(``budget.RPC_BUDGET_S``); each check's own vendor call is separately capped at 3 s
(``budget.CHECK_BUDGET_S``) and reported ``unknown`` rather than failing the whole request, so this
endpoint never legitimately times out from the caller's point of view — it always returns 200 with
whatever mix of pass / fail / unknown the six checks reached in time. **Nothing is written**: this
is the free-text path (LLD: "DS-08 with no writes").

The endpoint is internal: callers present the shared ``KP_RPC_TOKEN`` secret in
``x-internal-token``, the same convention as M17's ``/rpc/sanctions/screen`` (IF-17a). Errors use
the LLD §0.3 envelope ``{error: {code, message, details?}}``.
"""
from __future__ import annotations

import asyncio
import hmac
from typing import Any, Callable

from fastapi import APIRouter, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from starlette.concurrency import run_in_threadpool

from kp.m01_platform import ERROR_HTTP_STATUS, KpError, get_logger, get_secret

from .budget import RPC_BUDGET_S
from .engine import evaluate_adhoc
from .models import RollupResult, TrustSubject

SERVER_TIMEOUT_S = RPC_BUDGET_S
TOKEN_SECRET = "KP_RPC_TOKEN"
PATH = "/rpc/trust/adhoc"

_log = get_logger("kp.m24_trust.rpc")


class AdhocRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=500)
    email: str | None = Field(default=None, min_length=3, max_length=320)
    website: str | None = Field(default=None, min_length=1, max_length=2048)
    country: str | None = Field(default=None, pattern=r"^[A-Za-z]{2}$")

    @model_validator(mode="after")
    def _at_least_one(self) -> "AdhocRequest":
        if not (self.name or self.email or self.website):
            raise ValueError("send at least one of name, email or website")
        return self

    def to_subject(self) -> TrustSubject:
        return TrustSubject(
            name=self.name, email=self.email, website=self.website,
            country=self.country.upper() if self.country else None, is_adhoc=True,
        )


def response_body(r: RollupResult) -> dict[str, Any]:
    return r.to_dict()


def _error(code: str, message: str, details: dict[str, Any] | None = None) -> JSONResponse:
    body: dict[str, Any] = {"code": code, "message": message}
    if details:
        body["details"] = details
    return JSONResponse(status_code=int(ERROR_HTTP_STATUS.get(code, 500)), content={"error": body})


def _authorised(token: str | None) -> bool:
    try:
        expected = get_secret(TOKEN_SECRET)
    except KpError:
        _log.error("KP_RPC_TOKEN is not configured; refusing the trust ad hoc RPC")
        return False
    return bool(token) and hmac.compare_digest(str(token).encode(), expected.encode())


Evaluator = Callable[[AdhocRequest], RollupResult]


def _default_evaluator(req: AdhocRequest) -> RollupResult:
    return evaluate_adhoc(req.to_subject())


def build_router(evaluator: Evaluator = _default_evaluator, *, timeout_s: float = SERVER_TIMEOUT_S,
                 authorise: Callable[[str | None], bool] = _authorised) -> APIRouter:
    router = APIRouter()

    @router.post(PATH)
    async def adhoc(request: Request, x_internal_token: str | None = Header(default=None)) -> JSONResponse:
        if not authorise(x_internal_token):
            return _error("UNAUTHENTICATED", "internal token required")
        try:
            raw = await request.json()
        except ValueError:
            return _error("VALIDATION", "body must be JSON")
        try:
            req = AdhocRequest.model_validate(raw)
        except ValidationError as e:
            issues = [{"loc": list(i.get("loc", ())), "msg": i.get("msg", "")}
                      for i in e.errors(include_url=False, include_input=False, include_context=False)]
            return _error("VALIDATION", "invalid trust check request", {"issues": issues})
        try:
            result = await asyncio.wait_for(run_in_threadpool(evaluator, req), timeout=timeout_s)
        except asyncio.TimeoutError:
            # Every check already degrades to 'unknown' on its own budget; reaching the overall
            # timeout means the rollup itself could not be assembled in time.
            _log.warning("trust ad hoc check exceeded the overall budget", extra={"timeout_s": timeout_s})
            return _error("UPSTREAM_UNAVAILABLE", "trust check timed out")
        except KpError as e:
            return _error(e.code, str(e))
        except Exception:  # noqa: BLE001 — any failure here is "unavailable", never a 500 leak
            _log.exception("trust ad hoc check crashed")
            return _error("UPSTREAM_UNAVAILABLE", "trust check unavailable")
        return JSONResponse(status_code=200, content=response_body(result))

    return router


def create_app() -> FastAPI:
    app = FastAPI(title="kp trust rpc", docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(build_router())
    return app
