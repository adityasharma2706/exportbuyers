"""M18 persistence: fuzzy-match keys, merge decisions, and the serving-plane outbox.

``knowledge.company_match_key`` (migration 0018) holds the normalised name / city / address tokens
of each canonical company that M18 created or matched. Its pg_trgm GIN index is the fuzzy
prefilter; the score itself is computed in Python (``resolver``) so both stores score identically.

Everything runs inside the caller's transaction.
"""
from __future__ import annotations

import weakref
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

from kp.m02_queue import enqueue
from kp.m09_evidence import MemoryEvidenceRepo

from .models import NAME_PREFILTER, MatchKey
from .normalise import trigram_similarity

MAX_CANDIDATES = 50


class MatchStore(Protocol):
    def get_key(self, company_id: str) -> MatchKey | None: ...
    def upsert_key(self, key: MatchKey) -> None:
        """Inserts the key; for an existing company only fills a missing city / address (the
        name and country recorded first are kept)."""
        ...

    def candidates(self, country: str, name_norm: str, limit: int = MAX_CANDIDATES) -> list[MatchKey]: ...
    def merge_decision(self, a: str, b: str) -> str | None: ...


class Outbox(Protocol):
    def enqueue(self, type: str, queue: str, payload: Mapping[str, Any], idempotency_key: str) -> str: ...


# ---- PostgreSQL ------------------------------------------------------------------------------

class PgMatchStore:
    def __init__(self, conn: Any) -> None:
        from psycopg.rows import dict_row

        self.conn = conn
        self._dict_row = dict_row

    def _all(self, sql: str, params: Any = ()) -> list[dict[str, Any]]:
        with self.conn.cursor(row_factory=self._dict_row) as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]

    @staticmethod
    def _row(r: Mapping[str, Any]) -> MatchKey:
        return MatchKey(company_id=str(r["company_id"]), country=r["country"], name_norm=r["name_norm"],
                        city_norm=r.get("city_norm"), address_tokens=frozenset(r.get("address_tokens") or ()),
                        display_name=r.get("display_name") or "")

    def get_key(self, company_id: str) -> MatchKey | None:
        rows = self._all(
            "select k.company_id, k.country, k.name_norm, k.city_norm, k.address_tokens, c.display_name "
            "from knowledge.company_match_key k join knowledge.company c on c.id = k.company_id "
            "where k.company_id = %s::uuid", (company_id,))
        return self._row(rows[0]) if rows else None

    def upsert_key(self, key: MatchKey) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "insert into knowledge.company_match_key (company_id, country, name_norm, city_norm, address_tokens) "
                "values (%s::uuid, %s, %s, %s, %s::text[]) "
                "on conflict (company_id) do update set "
                "city_norm = coalesce(knowledge.company_match_key.city_norm, excluded.city_norm), "
                "address_tokens = case when cardinality(knowledge.company_match_key.address_tokens) > 0 "
                "then knowledge.company_match_key.address_tokens else excluded.address_tokens end, "
                "updated_at = now()",
                (key.company_id, key.country, key.name_norm, key.city_norm, sorted(key.address_tokens)),
            )

    def candidates(self, country: str, name_norm: str, limit: int = MAX_CANDIDATES) -> list[MatchKey]:
        # `%` uses the GIN index (default pg_trgm threshold 0.3, a superset); the explicit similarity
        # bound is the LLD's "> 0.5". Merged companies are never candidates.
        rows = self._all(
            "select k.company_id, k.country, k.name_norm, k.city_norm, k.address_tokens, c.display_name "
            "from knowledge.company_match_key k join knowledge.company c on c.id = k.company_id "
            "where k.country = %s and c.merged_into is null "
            "and k.name_norm %% %s and similarity(k.name_norm, %s) > %s "
            "order by similarity(k.name_norm, %s) desc, k.company_id limit %s",
            (country, name_norm, name_norm, NAME_PREFILTER, name_norm, limit),
        )
        return [self._row(r) for r in rows]

    def merge_decision(self, a: str, b: str) -> str | None:
        lo, hi = sorted((str(a), str(b)))
        rows = self._all("select decision from knowledge.merge_decision where a = %s::uuid and b = %s::uuid",
                         (lo, hi))
        return rows[0]["decision"] if rows else None


class PgOutbox:
    def __init__(self, conn: Any) -> None:
        self.conn = conn

    def enqueue(self, type: str, queue: str, payload: Mapping[str, Any], idempotency_key: str) -> str:
        return enqueue(self.conn, type=type, queue=queue, payload=dict(payload),  # type: ignore[arg-type]
                       idempotency_key=idempotency_key)


# ---- in-memory (tests, offline tools) ---------------------------------------------------------

class MemoryMatchStore:
    """Match keys kept beside a ``MemoryEvidenceRepo``; company state is read from the repo."""

    def __init__(self, repo: MemoryEvidenceRepo) -> None:
        self.repo = repo
        self.keys: dict[str, MatchKey] = {}

    def _active(self, company_id: str) -> bool:
        c = self.repo.get_company(company_id)
        # Closed companies stay candidates: re-seeing one must not create a second profile.
        return c is not None and c.merged_into is None

    def _with_name(self, k: MatchKey) -> MatchKey:
        c = self.repo.get_company(k.company_id)
        if c is None:
            return k
        return MatchKey(company_id=k.company_id, country=k.country, name_norm=k.name_norm, city_norm=k.city_norm,
                        address_tokens=k.address_tokens, display_name=c.display_name)

    def get_key(self, company_id: str) -> MatchKey | None:
        k = self.keys.get(str(company_id))
        return self._with_name(k) if k else None

    def upsert_key(self, key: MatchKey) -> None:
        prev = self.keys.get(key.company_id)
        if prev is not None:
            key = MatchKey(company_id=prev.company_id, country=prev.country, name_norm=prev.name_norm,
                           city_norm=prev.city_norm or key.city_norm,
                           address_tokens=prev.address_tokens or key.address_tokens)
        self.keys[key.company_id] = key

    def candidates(self, country: str, name_norm: str, limit: int = MAX_CANDIDATES) -> list[MatchKey]:
        scored: list[tuple[float, str, MatchKey]] = []
        for k in self.keys.values():
            if k.country != country or not self._active(k.company_id):
                continue
            sim = trigram_similarity(k.name_norm, name_norm)
            if sim > NAME_PREFILTER:
                scored.append((sim, k.company_id, k))
        scored.sort(key=lambda t: (-t[0], t[1]))
        return [self._with_name(k) for _, _, k in scored[:limit]]

    def merge_decision(self, a: str, b: str) -> str | None:
        lo, hi = sorted((str(a), str(b)))
        d = self.repo.merge_decisions.get((lo, hi))
        return str(d["decision"]) if d else None


@dataclass
class MemoryOutbox:
    jobs: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)

    def enqueue(self, type: str, queue: str, payload: Mapping[str, Any], idempotency_key: str) -> str:
        self.jobs.setdefault((type, idempotency_key), {"queue": queue, "payload": dict(payload)})
        return f"job-{len(self.jobs)}"


_memory_stores: "weakref.WeakKeyDictionary[MemoryEvidenceRepo, tuple[MemoryMatchStore, MemoryOutbox]]" = (
    weakref.WeakKeyDictionary())


def memory_backends(repo: MemoryEvidenceRepo) -> tuple[MemoryMatchStore, MemoryOutbox]:
    """The match store and outbox that belong to ``repo`` (created on first use)."""
    pair = _memory_stores.get(repo)
    if pair is None:
        pair = (MemoryMatchStore(repo), MemoryOutbox())
        _memory_stores[repo] = pair
    return pair
