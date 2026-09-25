"""M01 error model (LLD §0.3), mirroring the TS AppError."""
from __future__ import annotations

from typing import Any, Literal

ErrorCode = Literal[
    "VALIDATION",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMITED",
    "INSUFFICIENT_CREDITS",
    "POLICY_DENIED",
    "SANCTIONS_BLOCKED",
    "UPSTREAM_UNAVAILABLE",
    "SIGNUP_REQUIRED",
    "INTERNAL",
]

ERROR_HTTP_STATUS: dict[str, int] = {
    "VALIDATION": 400,
    "UNAUTHENTICATED": 401,
    "FORBIDDEN": 403,
    "NOT_FOUND": 404,
    "CONFLICT": 409,
    "RATE_LIMITED": 429,
    "INSUFFICIENT_CREDITS": 402,
    "POLICY_DENIED": 403,
    "SANCTIONS_BLOCKED": 403,
    "UPSTREAM_UNAVAILABLE": 503,
    "SIGNUP_REQUIRED": 401,
    "INTERNAL": 500,
}


class KpError(Exception):
    def __init__(self, code: ErrorCode, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message
        self.http = ERROR_HTTP_STATUS[code]
        self.details = details

    def to_response(self) -> dict[str, Any]:
        err: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            err["details"] = self.details
        return {"error": err}
