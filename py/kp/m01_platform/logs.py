"""M01 structured JSON logging (mirrors pino output from the TS side)."""
from __future__ import annotations

import contextvars
import json
import logging
import os
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

_correlation: contextvars.ContextVar[str | None] = contextvars.ContextVar("correlation_id", default=None)

_REDACT_KEYS = frozenset(
    {"password", "token", "secret", "api_key", "apikey", "authorization", "cookie", "email", "phone",
     "database_url", "redis_url"}
)
_STD_ATTRS = frozenset(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime"}


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: ("[redacted]" if str(k).lower() in _REDACT_KEYS else _redact(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact(v) for v in value]
    return value


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "time": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "service": os.environ.get("SERVICE_NAME", "kp"),
            "env": os.environ.get("APP_ENV", "local"),
            "region": os.environ.get("AWS_REGION", "ap-south-1"),
        }
        cid = _correlation.get()
        if cid:
            out["correlationId"] = cid
        try:
            from opentelemetry import trace

            sc = trace.get_current_span().get_span_context()
            if sc.is_valid:
                out["traceId"] = format(sc.trace_id, "032x")
                out["spanId"] = format(sc.span_id, "016x")
        except ImportError:
            pass
        for k, v in record.__dict__.items():
            if k not in _STD_ATTRS and not k.startswith("_"):
                out[k] = "[redacted]" if k.lower() in _REDACT_KEYS else _redact(v)
        if record.exc_info:
            out["err"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


_configured = False


def _configure() -> None:
    global _configured
    if _configured:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger("kp")
    root.handlers[:] = [handler]
    root.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
    root.propagate = False
    _configured = True


def get_logger(name: str = "kp") -> logging.Logger:
    """Returns a JSON logger. Pass structured fields via ``extra={...}``."""
    _configure()
    if name != "kp" and not name.startswith("kp."):
        name = f"kp.{name}"
    return logging.getLogger(name)


def current_correlation_id() -> str | None:
    return _correlation.get()


@contextmanager
def correlation(correlation_id: str) -> Iterator[None]:
    token = _correlation.set(correlation_id)
    try:
        yield
    finally:
        _correlation.reset(token)
