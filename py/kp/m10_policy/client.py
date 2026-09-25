"""M10 Python client (IF-10c) for the knowledge plane: ingestion checks the suppression list.

- ``is_suppressed(kind, raw) -> bool``
- ``norm_hash(kind, raw) -> str``   (see ``normalise.py``)
- ``any_suppressed(hashes) -> set[str]``

Reads ``knowledge.suppression`` directly (app_knowledge has SELECT on it). Pass ``conn`` to read
inside the caller's transaction; otherwise a short-lived autocommit connection is used.
Nothing is cached: a suppression must take effect on the very next ingestion check.
"""
from __future__ import annotations

import re
from contextlib import contextmanager
from typing import Any, Callable, ContextManager, Iterable, Iterator

from kp.m01_platform import KpError, get_logger, get_secret

from .normalise import norm_hash

_log = get_logger("kp.m10_policy.client")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")

ConnectionFactory = Callable[[], ContextManager[Any]]


def _default_connect() -> ContextManager[Any]:
    import psycopg

    return psycopg.connect(get_secret("DATABASE_URL"), autocommit=True)


_connect: ConnectionFactory = _default_connect


def set_connection_factory(fn: ConnectionFactory | None) -> None:
    """Replaces how the client opens a connection (``None`` restores the default)."""
    global _connect
    _connect = fn or _default_connect


@contextmanager
def _conn(conn: Any | None) -> Iterator[Any]:
    if conn is not None:
        yield conn
        return
    with _connect() as c:
        yield c


def any_suppressed(hashes: Iterable[str], *, conn: Any | None = None) -> set[str]:
    """The subset of ``hashes`` on the suppression list."""
    hs = list(dict.fromkeys(h for h in hashes if isinstance(h, str) and _HASH_RE.match(h)))
    if not hs:
        return set()
    with _conn(conn) as c:
        with c.cursor() as cur:
            cur.execute("select hash from knowledge.suppression where hash = any(%s)", (hs,))
            return {row[0] for row in cur.fetchall()}


def is_suppressed(kind: str, raw: str, *, conn: Any | None = None) -> bool:
    """IF-10c. Raises ``KpError('VALIDATION')`` for identifiers that cannot be normalised."""
    h = norm_hash(kind, raw)
    return h in any_suppressed([h], conn=conn)


def install_into_evidence_store() -> None:
    """Makes M09 use M10's normaliser, so there is one normalisation at run time.

    M09 keeps its own suppression read (inside the writer's transaction), which queries the same
    ``knowledge.suppression`` table as ``any_suppressed``; that is deliberately left in place.
    Call once at knowledge-plane boot, before any projection runs.
    """
    try:
        from kp.m09_evidence import set_norm_hash
    except ImportError as e:  # pragma: no cover - M09 is always present after build step 9
        raise KpError("INTERNAL", "kp.m09_evidence is not importable") from e
    set_norm_hash(norm_hash)
    _log.info("m10 normaliser installed into the evidence store")
