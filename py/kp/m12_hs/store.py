"""M12 persistence: knowledge.hs_version / hs_code / hs_correlation.

Each version load is one transaction (LLD M12): the version's rows are replaced, the orphan rule
is re-checked in SQL against what is actually committed, ``is_current`` is moved within the
version's family and EV-12 ``nomenclature.version_loaded {version}`` is written to the outbox —
all or nothing. Correlation tables are replaced per (from_version, to_version) pair, also in one
transaction.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator, Mapping, Protocol, Sequence

from kp.m01_platform import KpError, get_logger, get_secret
from kp.m02_queue import emit

from .models import (
    EMBEDDING_DIM,
    EV_NOMENCLATURE_VERSION_LOADED,
    MAX_ERRORS_REPORTED,
    CorrelationRow,
    HsCodeRow,
    HsLoadError,
    corresponding_hs_version,
    version_family,
)

_log = get_logger("kp.m12_hs.store")


def vector_literal(v: Sequence[float] | None) -> str | None:
    if v is None:
        return None
    return "[" + ",".join(repr(float(x)) for x in v) + "]"


def parse_vector(text: str | None) -> list[float] | None:
    if not text:
        return None
    body = text.strip().lstrip("[").rstrip("]")
    if not body:
        return None
    return [float(x) for x in body.split(",")]


class HsStore(Protocol):
    def version_exists(self, version: str) -> bool: ...
    def subheadings(self, hs_version: str) -> set[str]: ...
    def existing_codes(self, version: str) -> set[str]: ...
    def embeddings_by_text(self, version: str) -> dict[str, list[float]]: ...
    def replace_version(self, version: str, rows: Sequence[HsCodeRow], *, make_current: bool) -> str | None: ...
    def replace_correlations(self, from_version: str, to_version: str, rows: Sequence[CorrelationRow]) -> int: ...


class PgHsStore:
    """psycopg 3. Opens a short connection per operation unless one is supplied (the caller then
    owns commit/rollback of work outside ``replace_*``, which use nested transactions)."""

    def __init__(self, conn: Any | None = None, dsn: str | None = None) -> None:
        self._conn = conn
        self._dsn = dsn

    @contextmanager
    def _connection(self) -> Iterator[Any]:
        if self._conn is not None:
            yield self._conn
            return
        import psycopg

        with psycopg.connect(self._dsn or get_secret("DATABASE_URL")) as conn:
            yield conn

    def version_exists(self, version: str) -> bool:
        with self._connection() as conn:
            row = conn.execute("select 1 from knowledge.hs_version where version = %s", (version,)).fetchone()
            return row is not None

    def subheadings(self, hs_version: str) -> set[str]:
        with self._connection() as conn:
            rows = conn.execute(
                "select code from knowledge.hs_code where version = %s and level = 'subheading'", (hs_version,),
            ).fetchall()
            return {r[0] for r in rows}

    def existing_codes(self, version: str) -> set[str]:
        with self._connection() as conn:
            rows = conn.execute("select code from knowledge.hs_code where version = %s", (version,)).fetchall()
            return {r[0] for r in rows}

    def embeddings_by_text(self, version: str) -> dict[str, list[float]]:
        with self._connection() as conn:
            rows = conn.execute(
                "select coalesce(description_en_simple, description), embedding::text from knowledge.hs_code "
                "where version = %s and embedding is not null",
                (version,),
            ).fetchall()
        out: dict[str, list[float]] = {}
        for text, emb in rows:
            vec = parse_vector(emb)
            if vec is not None and len(vec) == EMBEDDING_DIM:
                out[text] = vec
        return out

    def replace_version(self, version: str, rows: Sequence[HsCodeRow], *, make_current: bool) -> str | None:
        family = version_family(version)
        with self._connection() as conn:
            with conn.transaction():
                conn.execute(
                    "insert into knowledge.hs_version (version, loaded_at, is_current) values (%s, now(), false) "
                    "on conflict (version) do update set loaded_at = excluded.loaded_at",
                    (version,),
                )
                conn.execute("delete from knowledge.hs_code where version = %s", (version,))
                with conn.cursor() as cur:
                    cur.executemany(
                        "insert into knowledge.hs_code (version, code, level, parent_code, description, "
                        "description_en_simple, export_policy, policy_conditions, policy_source_url, embedding) "
                        "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::vector)",
                        [(r.version, r.code, r.level, r.parent_code, r.description, r.description_en_simple,
                          r.export_policy, r.policy_conditions, r.policy_source_url, vector_literal(r.embedding))
                         for r in rows],
                    )
                self._check_committed_tree(conn, version, family)
                event_id: str | None = None
                if make_current:
                    conn.execute(
                        "update knowledge.hs_version set is_current = false "
                        "where is_current and version <> %s and regexp_replace(version, '[0-9]{4}$', '') = %s",
                        (version, family),
                    )
                    conn.execute("update knowledge.hs_version set is_current = true where version = %s", (version,))
                    event_id = emit(conn, EV_NOMENCLATURE_VERSION_LOADED, {"version": version})
        _log.info("hs version loaded", extra={"version": version, "codes": len(rows), "current": make_current})
        return event_id

    @staticmethod
    def _check_committed_tree(conn: Any, version: str, family: str) -> None:
        """Orphan rule, re-checked in SQL inside the load transaction."""
        if family == "ITCHS":
            orphans = conn.execute(
                "select c.code from knowledge.hs_code c where c.version = %s and not exists ("
                " select 1 from knowledge.hs_code p where p.version = %s and p.code = c.parent_code"
                " and p.level = 'subheading') order by c.code limit %s",
                (version, corresponding_hs_version(version), MAX_ERRORS_REPORTED),
            ).fetchall()
        else:
            orphans = conn.execute(
                "select c.code from knowledge.hs_code c where c.version = %s and c.parent_code is not null"
                " and not exists (select 1 from knowledge.hs_code p where p.version = c.version"
                " and p.code = c.parent_code) order by c.code limit %s",
                (version, MAX_ERRORS_REPORTED),
            ).fetchall()
        if orphans:
            raise HsLoadError(f"{version}: codes without a parent; load rolled back",
                              [f"{r[0]}: orphan" for r in orphans], version=version)

    def replace_correlations(self, from_version: str, to_version: str, rows: Sequence[CorrelationRow]) -> int:
        with self._connection() as conn:
            with conn.transaction():
                conn.execute(
                    "delete from knowledge.hs_correlation where from_version = %s and to_version = %s",
                    (from_version, to_version),
                )
                with conn.cursor() as cur:
                    cur.executemany(
                        "insert into knowledge.hs_correlation (from_version, from_code, to_version, to_code, relation) "
                        "values (%s, %s, %s, %s, %s)",
                        [(r.from_version, r.from_code, r.to_version, r.to_code, r.relation) for r in rows],
                    )
        _log.info("hs correlation loaded", extra={"from": from_version, "to": to_version, "rows": len(rows)})
        return len(rows)


class MemoryHsStore:
    """In-memory HsStore for tests and dry runs. Emitted events are collected in ``events``."""

    def __init__(self) -> None:
        self.versions: dict[str, bool] = {}
        self.codes: dict[str, dict[str, HsCodeRow]] = {}
        self.correlations: dict[tuple[str, str], list[CorrelationRow]] = {}
        self.events: list[tuple[str, Mapping[str, Any]]] = []

    def version_exists(self, version: str) -> bool:
        return version in self.versions

    def subheadings(self, hs_version: str) -> set[str]:
        return {c for c, r in self.codes.get(hs_version, {}).items() if r.level == "subheading"}

    def existing_codes(self, version: str) -> set[str]:
        return set(self.codes.get(version, {}))

    def embeddings_by_text(self, version: str) -> dict[str, list[float]]:
        return {r.embed_text(): list(r.embedding) for r in self.codes.get(version, {}).values() if r.embedding}

    def replace_version(self, version: str, rows: Sequence[HsCodeRow], *, make_current: bool) -> str | None:
        family = version_family(version)
        new = {r.code: r for r in rows}
        if family == "ITCHS":
            parents = self.subheadings(corresponding_hs_version(version))
            orphans = sorted(c for c, r in new.items() if r.parent_code not in parents)
        else:
            orphans = sorted(c for c, r in new.items() if r.parent_code is not None and r.parent_code not in new)
        if orphans:
            raise HsLoadError(f"{version}: codes without a parent; load rolled back",
                              [f"{c}: orphan" for c in orphans], version=version)
        self.versions.setdefault(version, False)
        self.codes[version] = new
        if not make_current:
            return None
        for v in list(self.versions):
            if version_family(v) == family:
                self.versions[v] = v == version
        self.events.append((EV_NOMENCLATURE_VERSION_LOADED, {"version": version}))
        return f"memory-event-{len(self.events)}"

    def replace_correlations(self, from_version: str, to_version: str, rows: Sequence[CorrelationRow]) -> int:
        for v in (from_version, to_version):
            if v not in self.versions:
                raise KpError("VALIDATION", f"version {v} is not loaded")
        self.correlations[(from_version, to_version)] = list(rows)
        return len(rows)
