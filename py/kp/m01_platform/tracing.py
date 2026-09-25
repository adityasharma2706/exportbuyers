"""M01 tracing: ``span(name)`` context manager over OpenTelemetry (no-op without a provider)."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator, Mapping

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

from .logs import current_correlation_id

_tracer = trace.get_tracer("exportbuyers.kp.m01_platform")


@contextmanager
def span(name: str, attributes: Mapping[str, str | int | float | bool] | None = None) -> Iterator[trace.Span]:
    with _tracer.start_as_current_span(name, record_exception=False, set_status_on_exception=False) as s:
        cid = current_correlation_id()
        if cid:
            s.set_attribute("correlation_id", cid)
        if attributes:
            s.set_attributes(dict(attributes))
        try:
            yield s
        except BaseException as e:
            s.record_exception(e)
            s.set_status(Status(StatusCode.ERROR, str(e)))
            raise
        else:
            s.set_status(Status(StatusCode.OK))
