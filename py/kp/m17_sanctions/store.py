"""M17 persistence: sanctions entries, list loads and screens.

``PgSanctionsStore(conn)`` works inside the caller's psycopg transaction (the caller commits), so
a screen, its sanctions_flag assertion (M09) and EV-03 commit together. ``MemorySanctionsStore``
is the test double.
"""
from __future__ import annotations

import json
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Iterable, Sequence

from kp.m01_platform import new_id

from .matching import TRIGRAM_PREFILTER
from .models import DiffStats, ListLoad, ParsedEntry, SanctionsEntry, ScreenRow, utcnow
from .normalise import normalise_names

CANDIDATE_LIMIT = 500


def _trigrams(s: str) -> set[str]:
    """pg_trgm-compatible trigram set (words padded with two leading and one trailing space)."""
    out: set[str] = set()
    for w in s.split():
        p = f"  {w} "
        out.update(p[i:i + 3] for i in range(len(p) - 2))
    return out


def trigram_similarity(a: str, b: str) -> float:
    ta, tb = _trigrams(a), _trigrams(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


class SanctionsStore(ABC):
    # ---- entries ----------------------------------------------------------------------------
    @abstractmethod
    def candidates(self, query_norms: Sequence[str], limit: int = CANDIDATE_LIMIT) -> list[SanctionsEntry]:
        """Active entries with any name at pg_trgm similarity > 0.3 to any query name."""

    @abstractmethod
    def entries_by_ids(self, ids: Sequence[str]) -> list[SanctionsEntry]: ...

    @abstractmethod
    def active_count(self, list_key: str) -> int: ...

    @abstractmethod
    def apply_list(self, list_key: str, list_version: str, entries: Sequence[ParsedEntry]) -> DiffStats:
        """Diffs by (list, list_uid): inserts new, updates changed, deactivates missing entries,
        and records the load. Returns what changed."""

    # ---- loads -------------------------------------------------------------------------------
    @abstractmethod
    def list_loads(self) -> dict[str, ListLoad]: ...

    def latest_load_at(self) -> datetime | None:
        loads = self.list_loads()
        return max((l.loaded_at for l in loads.values()), default=None)

    def list_versions(self) -> dict[str, str]:
        return {k: v.list_version for k, v in sorted(self.list_loads().items())}

    # ---- screens -----------------------------------------------------------------------------
    @abstractmethod
    def get_screen(self, subject_key: str) -> ScreenRow | None: ...

    @abstractmethod
    def put_screen(self, row: ScreenRow) -> None: ...

    @abstractmethod
    def set_decision(self, subject_key: str, decision: str, entry_ids: Sequence[str], at: datetime) -> bool:
        """Records an operator decision on an existing screen; False when there is none."""

    # ---- companies for re-screening -----------------------------------------------------------
    @abstractmethod
    def company_ids_after(self, after: str | None, limit: int) -> list[str]:
        """Live (non-merged) company ids in id order, strictly after ``after``."""


def _entry_from_row(r: Sequence[Any]) -> SanctionsEntry:
    return SanctionsEntry(id=str(r[0]), list=r[1], list_uid=r[2], names=tuple(r[3] or ()), names_norm=tuple(r[4] or ()),
                          countries=tuple(r[5] or ()), entity_type=r[6], list_version=r[7], active=bool(r[8]),
                          updated_at=r[9])


_ENTRY_COLS = "e.id, e.list, e.list_uid, e.names, e.names_norm, e.countries, e.entity_type, e.list_version, e.active, e.updated_at"


class PgSanctionsStore(SanctionsStore):
    def __init__(self, conn: Any) -> None:
        self.conn = conn

    def _rows(self, sql: str, params: Any = None) -> list[Any]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return list(cur.fetchall())

    def _exec(self, sql: str, params: Any = None) -> int:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return int(cur.rowcount or 0)

    def candidates(self, query_norms: Sequence[str], limit: int = CANDIDATE_LIMIT) -> list[SanctionsEntry]:
        qs = [q for q in dict.fromkeys(query_norms) if q]
        if not qs:
            return []
        # `%` uses the GIN trigram index with the threshold set for this transaction only.
        self._exec("select set_config('pg_trgm.similarity_threshold', %s, true)", (str(TRIGRAM_PREFILTER),))
        rows = self._rows(
            f"select {_ENTRY_COLS} from knowledge.sanctions_entry e where e.id in ("
            " select n.entry_id from unnest(%s::text[]) as q(v)"
            " join knowledge.sanctions_name n on n.name_norm %% q.v"
            " order by similarity(n.name_norm, q.v) desc limit %s) and e.active",
            (qs, limit),
        )
        return [_entry_from_row(r) for r in rows]

    def entries_by_ids(self, ids: Sequence[str]) -> list[SanctionsEntry]:
        if not ids:
            return []
        rows = self._rows(f"select {_ENTRY_COLS} from knowledge.sanctions_entry e where e.id = any(%s::uuid[])",
                          (list(ids),))
        return [_entry_from_row(r) for r in rows]

    def active_count(self, list_key: str) -> int:
        rows = self._rows("select count(*) from knowledge.sanctions_entry where list = %s and active", (list_key,))
        return int(rows[0][0]) if rows else 0

    def apply_list(self, list_key: str, list_version: str, entries: Sequence[ParsedEntry]) -> DiffStats:
        stats = DiffStats(list=list_key, list_version=list_version, entry_count=len(entries))
        existing = {r[0]: (str(r[1]), r[2], bool(r[3])) for r in self._rows(
            "select list_uid, id, content_hash, active from knowledge.sanctions_entry where list = %s for update",
            (list_key,))}
        seen: set[str] = set()
        for p in entries:
            if p.list_uid in seen:
                continue
            seen.add(p.list_uid)
            h = p.content_hash()
            norms = normalise_names(list(p.names))
            cur = existing.get(p.list_uid)
            if cur is None:
                eid = new_id()
                self._exec(
                    "insert into knowledge.sanctions_entry (id, list, list_uid, names, names_norm, countries, entity_type,"
                    " list_version, active, content_hash) values (%s, %s, %s, %s, %s, %s, %s, %s, true, %s)",
                    (eid, list_key, p.list_uid, list(p.names), norms, list(p.countries), p.entity_type, list_version, h))
                self._put_names(eid, norms)
                stats.added += 1
                stats.changed_entry_ids.append(eid)
                continue
            eid, old_hash, active = cur
            if old_hash == h and active:
                continue
            self._exec(
                "update knowledge.sanctions_entry set names = %s, names_norm = %s, countries = %s, entity_type = %s,"
                " list_version = %s, active = true, content_hash = %s, updated_at = now() where id = %s",
                (list(p.names), norms, list(p.countries), p.entity_type, list_version, h, eid))
            self._exec("delete from knowledge.sanctions_name where entry_id = %s", (eid,))
            self._put_names(eid, norms)
            stats.changed += 1
            stats.changed_entry_ids.append(eid)
        gone = [v[0] for k, v in existing.items() if k not in seen and v[2]]
        if gone:
            self._exec("update knowledge.sanctions_entry set active = false, updated_at = now(), list_version = %s"
                       " where id = any(%s::uuid[])", (list_version, gone))
            self._exec("delete from knowledge.sanctions_name where entry_id = any(%s::uuid[])", (gone,))
            stats.removed = len(gone)
            stats.changed_entry_ids.extend(gone)
        self._exec(
            "insert into knowledge.sanctions_list_load (list, list_version, loaded_at, entry_count, added, changed, removed)"
            " values (%s, %s, now(), %s, %s, %s, %s) on conflict (list) do update set list_version = excluded.list_version,"
            " loaded_at = excluded.loaded_at, entry_count = excluded.entry_count, added = excluded.added,"
            " changed = excluded.changed, removed = excluded.removed",
            (list_key, list_version, len(seen), stats.added, stats.changed, stats.removed))
        return stats

    def _put_names(self, entry_id: str, norms: Iterable[str]) -> None:
        with self.conn.cursor() as cur:
            cur.executemany(
                "insert into knowledge.sanctions_name (entry_id, name_norm) values (%s, %s) on conflict do nothing",
                [(entry_id, n) for n in norms])

    def list_loads(self) -> dict[str, ListLoad]:
        rows = self._rows("select list, list_version, loaded_at, entry_count, added, changed, removed"
                          " from knowledge.sanctions_list_load")
        return {r[0]: ListLoad(list=r[0], list_version=r[1], loaded_at=r[2], entry_count=r[3], added=r[4],
                               changed=r[5], removed=r[6]) for r in rows}

    def get_screen(self, subject_key: str) -> ScreenRow | None:
        rows = self._rows(
            "select subject_key, result, raw_result, matched_entry_ids, best_score, list_versions, input_hash,"
            " screened_at, decision, decided_at, decision_entry_ids from knowledge.sanctions_screen"
            " where subject_key = %s", (subject_key,))
        if not rows:
            return None
        r = rows[0]
        lv = r[5] if isinstance(r[5], dict) else json.loads(r[5] or "{}")
        return ScreenRow(subject_key=r[0], result=r[1], raw_result=r[2], matched_entry_ids=[str(x) for x in r[3] or []],
                         best_score=float(r[4] or 0), list_versions=dict(lv), input_hash=r[6], screened_at=r[7],
                         decision=r[8], decided_at=r[9],
                         decision_entry_ids=None if r[10] is None else [str(x) for x in r[10]])

    def put_screen(self, row: ScreenRow) -> None:
        self._exec(
            "insert into knowledge.sanctions_screen (subject_key, result, raw_result, matched_entry_ids, best_score,"
            " list_versions, input_hash, screened_at, decision, decided_at, decision_entry_ids)"
            " values (%s, %s, %s, %s::uuid[], %s, %s::jsonb, %s, %s, %s, %s, %s::uuid[])"
            " on conflict (subject_key) do update set result = excluded.result, raw_result = excluded.raw_result,"
            " matched_entry_ids = excluded.matched_entry_ids, best_score = excluded.best_score,"
            " list_versions = excluded.list_versions, input_hash = excluded.input_hash,"
            " screened_at = excluded.screened_at, decision = excluded.decision, decided_at = excluded.decided_at,"
            " decision_entry_ids = excluded.decision_entry_ids",
            (row.subject_key, row.result, row.raw_result, row.matched_entry_ids, row.best_score,
             json.dumps(row.list_versions), row.input_hash, row.screened_at, row.decision, row.decided_at,
             row.decision_entry_ids))

    def set_decision(self, subject_key: str, decision: str, entry_ids: Sequence[str], at: datetime) -> bool:
        result = "hit" if decision == "confirmed" else "clear"
        n = self._exec(
            "update knowledge.sanctions_screen set decision = %s, decided_at = %s, decision_entry_ids = %s::uuid[],"
            " result = %s where subject_key = %s", (decision, at, list(entry_ids), result, subject_key))
        return n > 0

    def company_ids_after(self, after: str | None, limit: int) -> list[str]:
        if after is None:
            rows = self._rows("select id from knowledge.company where status <> 'merged' order by id limit %s", (limit,))
        else:
            rows = self._rows("select id from knowledge.company where status <> 'merged' and id > %s::uuid"
                              " order by id limit %s", (after, limit))
        return [str(r[0]) for r in rows]


class MemorySanctionsStore(SanctionsStore):
    """In-memory store for tests. The prefilter mirrors pg_trgm's similarity."""

    def __init__(self) -> None:
        self.entries: dict[str, SanctionsEntry] = {}
        self.hashes: dict[str, str] = {}
        self.loads: dict[str, ListLoad] = {}
        self.screens: dict[str, ScreenRow] = {}
        self.companies: list[str] = []

    def candidates(self, query_norms: Sequence[str], limit: int = CANDIDATE_LIMIT) -> list[SanctionsEntry]:
        out = []
        for e in self.entries.values():
            if e.active and any(trigram_similarity(q, n) > TRIGRAM_PREFILTER for q in query_norms for n in e.names_norm):
                out.append(e)
        return out[:limit]

    def entries_by_ids(self, ids: Sequence[str]) -> list[SanctionsEntry]:
        return [self.entries[i] for i in ids if i in self.entries]

    def active_count(self, list_key: str) -> int:
        return sum(1 for e in self.entries.values() if e.list == list_key and e.active)

    def apply_list(self, list_key: str, list_version: str, entries: Sequence[ParsedEntry]) -> DiffStats:
        stats = DiffStats(list=list_key, list_version=list_version, entry_count=len(entries))
        by_uid = {e.list_uid: e for e in self.entries.values() if e.list == list_key}
        seen: set[str] = set()
        now = utcnow()
        for p in entries:
            if p.list_uid in seen:
                continue
            seen.add(p.list_uid)
            h = p.content_hash()
            cur = by_uid.get(p.list_uid)
            if cur is not None and self.hashes.get(cur.id) == h and cur.active:
                continue
            eid = cur.id if cur is not None else new_id()
            self.entries[eid] = SanctionsEntry(id=eid, list=list_key, list_uid=p.list_uid, names=tuple(p.names),
                                               names_norm=tuple(normalise_names(list(p.names))),
                                               countries=tuple(p.countries), entity_type=p.entity_type,
                                               list_version=list_version, active=True, updated_at=now)
            self.hashes[eid] = h
            if cur is None:
                stats.added += 1
            else:
                stats.changed += 1
            stats.changed_entry_ids.append(eid)
        for uid, e in by_uid.items():
            if uid not in seen and e.active:
                self.entries[e.id] = SanctionsEntry(**{**e.__dict__, "active": False, "updated_at": now,
                                                       "list_version": list_version})
                stats.removed += 1
                stats.changed_entry_ids.append(e.id)
        self.loads[list_key] = ListLoad(list=list_key, list_version=list_version, loaded_at=now, entry_count=len(seen),
                                        added=stats.added, changed=stats.changed, removed=stats.removed)
        return stats

    def list_loads(self) -> dict[str, ListLoad]:
        return dict(self.loads)

    def get_screen(self, subject_key: str) -> ScreenRow | None:
        r = self.screens.get(subject_key)
        return None if r is None else ScreenRow(**r.__dict__)

    def put_screen(self, row: ScreenRow) -> None:
        self.screens[row.subject_key] = ScreenRow(**row.__dict__)

    def set_decision(self, subject_key: str, decision: str, entry_ids: Sequence[str], at: datetime) -> bool:
        r = self.screens.get(subject_key)
        if r is None:
            return False
        r.decision, r.decided_at, r.decision_entry_ids = decision, at, list(entry_ids)
        r.result = "hit" if decision == "confirmed" else "clear"
        return True

    def company_ids_after(self, after: str | None, limit: int) -> list[str]:
        ids = sorted(self.companies)
        if after is not None:
            ids = [i for i in ids if i > after]
        return ids[:limit]
