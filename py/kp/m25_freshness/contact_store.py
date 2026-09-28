"""Reads the raw contact value M25 needs to re-check (``knowledge.contact_value.value``).

M09 deliberately keeps contact values out of its own read API (LLD M09: "Contact slots in the
profile_doc ... never hold values. Values live only in contact_value" and "``v_contact_value`` is
granted only to the role ``app_reveal``, which is used only by M29's repo"). That grant restricts
the *serving* plane's cross-schema view; M25 runs in the knowledge plane, on the same footing as
M22 (which writes ``contact_value`` in the first place), and needs the raw value to actually
re-check it — without it there is nothing to send to libphonenumber, the MX/vendor check or the
HTTP fetch. This module is therefore M25's own minimal, direct reader of that one column.
"""
from __future__ import annotations

import threading
from typing import Protocol

from kp.m01_platform import get_logger, get_secret

_log = get_logger("kp.m25_freshness.contact_store")

_SELECT = "select value from knowledge.contact_value where assertion_id = %s::uuid"


class ContactValueSource(Protocol):
    def get(self, assertion_id: str) -> str | None: ...


class PgContactValues:
    """Opens a short-lived autocommit connection per lookup (mirrors M08's ``_db_loader``)."""

    def get(self, assertion_id: str) -> str | None:
        import psycopg

        try:
            with psycopg.connect(get_secret("DATABASE_URL"), autocommit=True) as conn:
                row = conn.execute(_SELECT, (assertion_id,)).fetchone()
        except Exception:  # noqa: BLE001 — a lookup failure just means "nothing to check"
            _log.warning("contact_value lookup failed", extra={"assertion_id": assertion_id})
            return None
        return row[0] if row else None


class MemoryContactValues:
    """Dictionary-backed implementation for tests and offline tools."""

    def __init__(self, values: dict[str, str] | None = None) -> None:
        self.values = dict(values or {})

    def get(self, assertion_id: str) -> str | None:
        return self.values.get(assertion_id)


_default: ContactValueSource | None = None
_lock = threading.Lock()


def default_contact_value_source() -> ContactValueSource:
    global _default
    with _lock:
        if _default is None:
            _default = PgContactValues()
        return _default


def set_contact_value_source_for_testing(source: ContactValueSource | None) -> None:
    global _default
    with _lock:
        _default = source


__all__ = [
    "ContactValueSource",
    "MemoryContactValues",
    "PgContactValues",
    "default_contact_value_source",
    "set_contact_value_source_for_testing",
]
