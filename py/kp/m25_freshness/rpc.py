"""IF-25a over HTTP: the re-verification RPC for the serving plane (M29's reveal, M30's post-report
path).

    POST /rpc/reverify   {assertionIds, trigger: 'reveal'|'report'|'schedule', triggerRef}
      → 200 {outcomes: [{assertionId, status, checkedAt}]}
      → 400 VALIDATION, 401 UNAUTHENTICATED

LLD M25: "it waits up to reverify_rpc_wait_ms. Anything still pending comes back as unknown while
the job continues in the background." ``pipeline.reverify`` already enforces that wait itself
(``budget.py``'s shared pool), so this handler does not add a second timeout on top of it — doing
so would only ever cut the budget short, never extend it. The endpoint is internal: callers present
the shared ``KP_RPC_TOKEN`` secret in ``x-internal-token``, the same convention as M17/M24.
"""
from __future__ import annotations

import hmac
from typing import Any, Callable

from fastapi import APIRouter, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from kp.m01_platform import ERROR_HTTP_STATUS, KpError, get_logger, get_secret

from .models import Trigger, VerifyOutcome
from .pipeline import reverify

TOKEN_SECRET = "KP_RPC_TOKEN"
PATH = "/rpc/reverify"

_log = get_logger("kp.m25_freshness.rpc")


class ReverifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    assertion_ids: list[str] = Field(alias="assertionIds", min_length=1, max_length=500)
    trigger: Trigger
    trigger_ref: str = Field(alias="triggerRef", min_length=1, max_length=200)


def response_body(outcomes: list[VerifyOutcome]) -> dict[str, Any]:
    return {"outcomes": [o.to_dict() for o in outcomes]}


def _error(code: str, message: str, details: dict[str, Any] | None = None) -> JSONResponse:
    body: dict[str, Any] = {"code": code, "message": message}
    if details:
        body["details"] = details
    return JSONResponse(status_code=int(ERROR_HTTP_STATUS.get(code, 500)), content={"error": body})


def _authorised(token: str | None) -> bool:
    try:
        expected = get_secret(TOKEN_SECRET)
    except KpError:
        _log.error("KP_RPC_TOKEN is not configured; refusing the reverify RPC")
        return False
    return bool(token) and hmac.compare_digest(str(token).encode(), expected.encode())


Reverifier = Callable[[list[str], Trigger, str], list[VerifyOutcome]]


def _default_reverifier(assertion_ids: list[str], trigger: Trigger, trigger_ref: str) -> list[VerifyOutcome]:
    return reverify(assertion_ids, trigger, trigger_ref)


def build_router(reverifier: Reverifier = _default_reverifier,
                 authorise: Callable[[str | None], bool] = _authorised) -> APIRouter:
    router = APIRouter()

    @router.post(PATH)
    async def do_reverify(request: Request, x_internal_token: str | None = Header(default=None)) -> JSONResponse:
        if not authorise(x_internal_token):
            return _error("UNAUTHENTICATED", "internal token required")
        try:
            raw = await request.json()
        except ValueError:
            return _error("VALIDATION", "body must be JSON")
        try:
            req = ReverifyRequest.model_validate(raw)
        except ValidationError as e:
            issues = [{"loc": list(i.get("loc", ())), "msg": i.get("msg", "")}
                      for i in e.errors(include_url=False, include_input=False, include_context=False)]
            return _error("VALIDATION", "invalid reverify request", {"issues": issues})
        try:
            outcomes = await run_in_threadpool(reverifier, req.assertion_ids, req.trigger, req.trigger_ref)
        except KpError as e:
            return _error(e.code, str(e))
        except Exception:  # noqa: BLE001 — never leak a 500 to the caller
            _log.exception("reverify RPC crashed")
            return _error("INTERNAL", "reverify failed")
        return JSONResponse(status_code=200, content=response_body(outcomes))

    return router


def create_app() -> FastAPI:
    app = FastAPI(title="kp freshness rpc", docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(build_router())
    return app


__all__ = ["PATH", "ReverifyRequest", "build_router", "create_app", "response_body"]
