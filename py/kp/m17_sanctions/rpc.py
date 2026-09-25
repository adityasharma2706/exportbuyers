"""IF-17a: synchronous screening RPC for the serving plane (reveal, draft, trust check).

    POST /rpc/sanctions/screen   {companyId} | {name, country?}
      → 200 {result, listVersions, screenedAt}
      → 400 VALIDATION, 401 UNAUTHENTICATED, 404 NOT_FOUND, 503 UPSTREAM_UNAVAILABLE (timeout / error)

The server budget is 800 ms. For a company the stored result is returned when it was taken after
the latest list load; otherwise the company is screened live (and the screen is persisted). The
endpoint is internal: callers present the shared ``KP_RPC_TOKEN`` secret in ``x-internal-token``.
Errors use the LLD §0.3 envelope ``{error: {code, message, details?}}``.
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

from .models import ScreenResult
from .screener import screen_company_for_rpc, screen_name

SERVER_TIMEOUT_S = 0.8
TOKEN_SECRET = "KP_RPC_TOKEN"
PATH = "/rpc/sanctions/screen"

_log = get_logger("kp.m17_sanctions.rpc")


class ScreenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    company_id: str | None = Field(default=None, alias="companyId", pattern=r"^[0-9a-fA-F-]{36}$")
    name: str | None = Field(default=None, min_length=1, max_length=500)
    country: str | None = Field(default=None, pattern=r"^[A-Za-z]{2}$")

    @model_validator(mode="after")
    def _one_subject(self) -> "ScreenRequest":
        if (self.company_id is None) == (self.name is None):
            raise ValueError("send exactly one of companyId or name")
        if self.company_id is not None and self.country is not None:
            raise ValueError("country applies only to a name screen")
        return self


def response_body(r: ScreenResult) -> dict[str, Any]:
    return {"result": r.result, "listVersions": r.list_versions, "screenedAt": r.screened_at.isoformat()}


def _error(code: str, message: str, details: dict[str, Any] | None = None) -> JSONResponse:
    body: dict[str, Any] = {"code": code, "message": message}
    if details:
        body["details"] = details
    return JSONResponse(status_code=int(ERROR_HTTP_STATUS.get(code, 500)), content={"error": body})


def _authorised(token: str | None) -> bool:
    try:
        expected = get_secret(TOKEN_SECRET)
    except KpError:
        _log.error("KP_RPC_TOKEN is not configured; refusing sanctions RPC")
        return False
    return bool(token) and hmac.compare_digest(str(token).encode(), expected.encode())


Screener = Callable[[ScreenRequest], ScreenResult]


def _default_screener(req: ScreenRequest) -> ScreenResult:
    if req.company_id is not None:
        return screen_company_for_rpc(req.company_id.lower())
    assert req.name is not None
    return screen_name(req.name, req.country.upper() if req.country else None)


def build_router(screener: Screener = _default_screener, *, timeout_s: float = SERVER_TIMEOUT_S,
                 authorise: Callable[[str | None], bool] = _authorised) -> APIRouter:
    router = APIRouter()

    @router.post(PATH)
    async def screen(request: Request, x_internal_token: str | None = Header(default=None)) -> JSONResponse:
        if not authorise(x_internal_token):
            return _error("UNAUTHENTICATED", "internal token required")
        try:
            raw = await request.json()
        except ValueError:
            return _error("VALIDATION", "body must be JSON")
        try:
            req = ScreenRequest.model_validate(raw)
        except ValidationError as e:
            issues = [{"loc": list(i.get("loc", ())), "msg": i.get("msg", "")}
                      for i in e.errors(include_url=False, include_input=False, include_context=False)]
            return _error("VALIDATION", "invalid screening request", {"issues": issues})
        try:
            result = await asyncio.wait_for(run_in_threadpool(screener, req), timeout=timeout_s)
        except asyncio.TimeoutError:
            _log.warning("sanctions screen timed out", extra={"timeout_s": timeout_s,
                                                               "company": req.company_id is not None})
            return _error("UPSTREAM_UNAVAILABLE", "sanctions screen timed out")
        except KpError as e:
            if e.code in ("VALIDATION", "NOT_FOUND"):
                return _error(e.code, str(e))
            _log.warning("sanctions screen failed", extra={"code": e.code})
            return _error("UPSTREAM_UNAVAILABLE", "sanctions screener unavailable")
        except Exception:  # noqa: BLE001 — any failure is "unavailable"; callers fail closed
            _log.exception("sanctions screen crashed")
            return _error("UPSTREAM_UNAVAILABLE", "sanctions screener unavailable")
        return JSONResponse(status_code=200, content=response_body(result))

    return router


def create_app() -> FastAPI:
    app = FastAPI(title="kp sanctions rpc", docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(build_router())
    return app
