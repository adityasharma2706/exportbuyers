"""M09 persistence. ``EvidenceRepo`` is the storage contract used by the store, the command
handler and the projection builder; ``PgEvidenceRepo`` implements it over a psycopg 3
connection whose transaction the caller owns, and ``MemoryEvidenceRepo`` implements it in
memory for unit tests and offline tools.
"""
from __future__ import annotations

import copy
import json
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping

from kp.m01_platform import KpError, get_logger
from kp.m02_queue import emit as queue_emit
from kp.m02_queue import enqueue as queue_enqueue

from .models import ANCHOR_KINDS, AnchorConflict, Assertion, Company, ContactValue
from .norm import installed_suppression_checker

_log = get_logger("kp.m09_evidence.repo")

SEARCH_DOC_COLUMNS: tuple[str, ...] = (
    "company_id", "hs_heading", "doc", "tsv_text", "country", "buyer_type", "trust_level", "last_activity",
    "shipment_freq", "volume_score", "origin_india", "origin_competitor", "contact_types", "is_logistics",
    "sanctions_block", "identifier_hashes", "projection_version", "built_at",
)
PROFILE_DOC_COLUMNS: tuple[str, ...] = (
    "company_id", "doc", "identifier_hashes", "sanctions_block", "is_logistics", "projection_version", "built_at",
)


class EvidenceRepo(ABC):
    # companies and anchors
    @abstractmethod
    def get_company(self, company_id: str) -> Company | None: ...
    @abstractmethod
    def insert_company(self, c: Company) -> None: ...
    @abstractmethod
    def update_company(self, company_id: str, fields: Mapping[str, Any]) -> None: ...
    @abstractmethod
    def get_anchor(self, kind: str, value_norm: str) -> str | None: ...
    @abstractmethod
    def insert_anchor(self, kind: str, value_norm: str, company_id: str) -> None: ...
    @abstractmethod
    def anchors_of(self, company_id: str) -> list[tuple[str, str]]: ...
    @abstractmethod
    def move_anchors(self, from_id: str, to_id: str) -> None: ...

    # assertions
    @abstractmethod
    def get_assertion(self, assertion_id: str) -> Assertion | None: ...
    @abstractmethod
    def active_assertions(self, subject_id: str, attribute: str, polarity: str) -> list[Assertion]: ...
    @abstractmethod
    def list_assertions(self, subject_id: str, attributes: list[str] | None,
                        include_superseded: bool) -> list[Assertion]: ...
    @abstractmethod
    def insert_assertion(self, a: Assertion) -> None: ...
    @abstractmethod
    def mark_superseded(self, ids: list[str], by: str) -> None: ...
    @abstractmethod
    def touch_checked_at(self, assertion_id: str, checked_at: datetime) -> None: ...
    @abstractmethod
    def repoint_assertions(self, from_id: str, to_id: str) -> int: ...
    @abstractmethod
    def stale(self, attribute_prefix: str, cutoff: datetime, limit: int) -> list[Assertion]: ...

    # contact values
    @abstractmethod
    def put_contact_value(self, cv: ContactValue) -> None: ...
    @abstractmethod
    def purge_contact_values(self, hashes: list[str]) -> list[str]: ...
    @abstractmethod
    def repoint_contact_values(self, from_id: str, to_id: str) -> None: ...

    # read models
    @abstractmethod
    def replace_search_docs(self, company_id: str, rows: list[dict[str, Any]]) -> None: ...
    @abstractmethod
    def delete_search_docs(self, company_id: str) -> None: ...
    @abstractmethod
    def upsert_profile_doc(self, row: dict[str, Any]) -> None: ...
    @abstractmethod
    def delete_profile_doc(self, company_id: str) -> None: ...
    @abstractmethod
    def companies_for_hashes(self, hashes: list[str]) -> list[str]: ...

    # merge decisions
    @abstractmethod
    def record_merge_decision(self, a: str, b: str, decision: str, review_item_id: str | None, actor: str) -> None: ...

    # suppression, events and jobs
    @abstractmethod
    def db_suppressed(self, hashes: list[str]) -> set[str]: ...
    @abstractmethod
    def emit(self, type: str, payload: Mapping[str, Any]) -> str: ...
    @abstractmethod
    def enqueue(self, type: str, payload: Mapping[str, Any], idempotency_key: str, run_at: datetime | None) -> str: ...

    def suppressed(self, hashes: Iterable[str]) -> set[str]:
        hs = [h for h in dict.fromkeys(hashes) if h]
        if not hs:
            return set()
        checker = installed_suppression_checker()
        if checker is not None:
            return set(checker(hs)) & set(hs)
        return self.db_suppressed(hs)


# ---- PostgreSQL ------------------------------------------------------------------------------

_ASSERTION_COLS = (
    "id, subject_type, subject_id, attribute, value, polarity, source_id, source_type, source_ref, observed_at, "
    "checked_at, confidence, can_display, can_export, personal_data_class, region, producer, producer_version, "
    "llm_assisted, superseded_by, hs_heading, created_at"
)
_COMPANY_COLS = "id, status, merged_into, display_name, country, city, primary_domain, created_at, updated_at"
_COMPANY_UPDATABLE = frozenset({"status", "merged_into", "display_name", "country", "city", "primary_domain"})


class PgEvidenceRepo(EvidenceRepo):
    """Runs every statement on ``conn`` (psycopg 3); the caller commits."""

    def __init__(self, conn: Any) -> None:
        from psycopg.rows import dict_row
        from psycopg.types.json import Jsonb

        self.conn = conn
        self._dict_row = dict_row
        self._jsonb = Jsonb

    def _all(self, sql: str, params: Any = ()) -> list[dict[str, Any]]:
        with self.conn.cursor(row_factory=self._dict_row) as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]

    def _one(self, sql: str, params: Any = ()) -> dict[str, Any] | None:
        rows = self._all(sql, params)
        return rows[0] if rows else None

    def _exec(self, sql: str, params: Any = ()) -> int:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount

    # companies
    def get_company(self, company_id: str) -> Company | None:
        r = self._one(f"select {_COMPANY_COLS} from knowledge.company where id = %s::uuid", (company_id,))
        return Company.model_validate(r) if r else None

    def insert_company(self, c: Company) -> None:
        self._exec(
            "insert into knowledge.company (id, status, merged_into, display_name, country, city, primary_domain, "
            "created_at, updated_at) values (%s::uuid, %s, %s::uuid, %s, %s, %s, %s, %s, %s)",
            (c.id, c.status, c.merged_into, c.display_name, c.country, c.city, c.primary_domain,
             c.created_at, c.updated_at),
        )

    def update_company(self, company_id: str, fields: Mapping[str, Any]) -> None:
        bad = set(fields) - _COMPANY_UPDATABLE
        if bad:
            raise KpError("VALIDATION", f"company fields not updatable: {', '.join(sorted(bad))}")
        if not fields:
            return
        sets = ", ".join(f"{k} = %s" for k in fields)
        self._exec(f"update knowledge.company set {sets}, updated_at = now() where id = %s::uuid",
                   (*fields.values(), company_id))

    def get_anchor(self, kind: str, value_norm: str) -> str | None:
        r = self._one("select company_id from knowledge.company_anchor where kind = %s and value_norm = %s",
                      (kind, value_norm))
        return str(r["company_id"]) if r else None

    def insert_anchor(self, kind: str, value_norm: str, company_id: str) -> None:
        r = self._one(
            "insert into knowledge.company_anchor (kind, value_norm, company_id) values (%s, %s, %s::uuid) "
            "on conflict (kind, value_norm) do nothing returning company_id",
            (kind, value_norm, company_id),
        )
        if r is None:
            existing = self.get_anchor(kind, value_norm)
            if existing is not None and existing != company_id:
                raise AnchorConflict(kind, value_norm, existing)

    def anchors_of(self, company_id: str) -> list[tuple[str, str]]:
        rows = self._all("select kind, value_norm from knowledge.company_anchor where company_id = %s::uuid "
                         "order by kind, value_norm", (company_id,))
        return [(r["kind"], r["value_norm"]) for r in rows]

    def move_anchors(self, from_id: str, to_id: str) -> None:
        # (kind, value_norm) is the primary key, so a straight update cannot collide.
        self._exec("update knowledge.company_anchor set company_id = %s::uuid where company_id = %s::uuid",
                   (to_id, from_id))

    # assertions
    def get_assertion(self, assertion_id: str) -> Assertion | None:
        r = self._one(f"select {_ASSERTION_COLS} from knowledge.assertion where id = %s::uuid", (assertion_id,))
        return Assertion.model_validate(r) if r else None

    def active_assertions(self, subject_id: str, attribute: str, polarity: str) -> list[Assertion]:
        rows = self._all(
            f"select {_ASSERTION_COLS} from knowledge.assertion where subject_id = %s::uuid and attribute = %s "
            "and polarity = %s and superseded_by is null order by created_at for update",
            (subject_id, attribute, polarity),
        )
        return [Assertion.model_validate(r) for r in rows]

    def list_assertions(self, subject_id: str, attributes: list[str] | None,
                        include_superseded: bool) -> list[Assertion]:
        sql = f"select {_ASSERTION_COLS} from knowledge.assertion where subject_id = %s::uuid"
        params: list[Any] = [subject_id]
        if attributes is not None:
            sql += " and attribute = any(%s)"
            params.append(list(attributes))
        if not include_superseded:
            sql += " and superseded_by is null"
        sql += " order by attribute, created_at"
        return [Assertion.model_validate(r) for r in self._all(sql, params)]

    def insert_assertion(self, a: Assertion) -> None:
        self._exec(
            "insert into knowledge.assertion (id, subject_type, subject_id, attribute, value, polarity, source_id, "
            "source_type, source_ref, observed_at, checked_at, confidence, can_display, can_export, "
            "personal_data_class, region, producer, producer_version, llm_assisted, superseded_by, hs_heading, "
            "created_at) values (%s::uuid, %s, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, "
            "%s, %s, %s::uuid, %s, %s)",
            (a.id, a.subject_type, a.subject_id, a.attribute, self._jsonb(a.value), a.polarity, a.source_id,
             a.source_type, self._jsonb(a.source_ref), a.observed_at, a.checked_at, a.confidence, a.can_display,
             a.can_export, a.personal_data_class, a.region, a.producer, a.producer_version, a.llm_assisted,
             a.superseded_by, a.hs_heading, a.created_at),
        )

    def mark_superseded(self, ids: list[str], by: str) -> None:
        if ids:
            self._exec("update knowledge.assertion set superseded_by = %s::uuid where id = any(%s::uuid[]) "
                       "and superseded_by is null", (by, ids))

    def touch_checked_at(self, assertion_id: str, checked_at: datetime) -> None:
        self._exec("update knowledge.assertion set checked_at = greatest(checked_at, %s) where id = %s::uuid",
                   (checked_at, assertion_id))

    def repoint_assertions(self, from_id: str, to_id: str) -> int:
        return self._exec("update knowledge.assertion set subject_id = %s::uuid where subject_id = %s::uuid",
                          (to_id, from_id))

    def stale(self, attribute_prefix: str, cutoff: datetime, limit: int) -> list[Assertion]:
        pattern = attribute_prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        rows = self._all(
            f"select {_ASSERTION_COLS} from knowledge.assertion where attribute like %s and checked_at < %s "
            "and superseded_by is null and polarity = 'positive' order by checked_at limit %s",
            (pattern, cutoff, limit),
        )
        return [Assertion.model_validate(r) for r in rows]

    # contact values
    def put_contact_value(self, cv: ContactValue) -> None:
        self._exec(
            "insert into knowledge.contact_value (assertion_id, company_id, kind, value, value_hash) "
            "values (%s::uuid, %s::uuid, %s, %s, %s) on conflict (assertion_id) do update set "
            "company_id = excluded.company_id, kind = excluded.kind, value = excluded.value, "
            "value_hash = excluded.value_hash",
            (cv.assertion_id, cv.company_id, cv.kind, cv.value, cv.value_hash),
        )

    def purge_contact_values(self, hashes: list[str]) -> list[str]:
        if not hashes:
            return []
        rows = self._all("delete from knowledge.contact_value where value_hash = any(%s) returning company_id",
                         (hashes,))
        return list(dict.fromkeys(str(r["company_id"]) for r in rows))

    def repoint_contact_values(self, from_id: str, to_id: str) -> None:
        self._exec("update knowledge.contact_value set company_id = %s::uuid where company_id = %s::uuid",
                   (to_id, from_id))

    # read models
    def replace_search_docs(self, company_id: str, rows: list[dict[str, Any]]) -> None:
        self.delete_search_docs(company_id)
        for r in rows:
            self._exec(
                "insert into knowledge.search_doc (company_id, hs_heading, doc, tsv, country, buyer_type, trust_level, "
                "last_activity, shipment_freq, volume_score, origin_india, origin_competitor, contact_types, "
                "is_logistics, sanctions_block, identifier_hashes, projection_version, built_at) values "
                "(%s::uuid, %s, %s, to_tsvector('simple', %s), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (r["company_id"], r["hs_heading"], self._jsonb(r["doc"]), r["tsv_text"], r["country"], r["buyer_type"],
                 r["trust_level"], r["last_activity"], r["shipment_freq"], r["volume_score"], r["origin_india"],
                 r["origin_competitor"], r["contact_types"], r["is_logistics"], r["sanctions_block"],
                 r["identifier_hashes"], r["projection_version"], r["built_at"]),
            )

    def delete_search_docs(self, company_id: str) -> None:
        self._exec("delete from knowledge.search_doc where company_id = %s::uuid", (company_id,))

    def upsert_profile_doc(self, row: dict[str, Any]) -> None:
        self._exec(
            "insert into knowledge.profile_doc (company_id, doc, identifier_hashes, sanctions_block, is_logistics, "
            "projection_version, built_at) values (%s::uuid, %s, %s, %s, %s, %s, %s) on conflict (company_id) do "
            "update set doc = excluded.doc, identifier_hashes = excluded.identifier_hashes, "
            "sanctions_block = excluded.sanctions_block, is_logistics = excluded.is_logistics, "
            "projection_version = excluded.projection_version, built_at = excluded.built_at",
            (row["company_id"], self._jsonb(row["doc"]), row["identifier_hashes"], row["sanctions_block"],
             row["is_logistics"], row["projection_version"], row["built_at"]),
        )

    def delete_profile_doc(self, company_id: str) -> None:
        self._exec("delete from knowledge.profile_doc where company_id = %s::uuid", (company_id,))

    def companies_for_hashes(self, hashes: list[str]) -> list[str]:
        if not hashes:
            return []
        rows = self._all(
            "select company_id from knowledge.profile_doc where identifier_hashes && %s::text[] "
            "union select company_id from knowledge.search_doc where identifier_hashes && %s::text[] "
            "union select company_id from knowledge.contact_value where value_hash = any(%s::text[])",
            (hashes, hashes, hashes),
        )
        return [str(r["company_id"]) for r in rows]

    def record_merge_decision(self, a: str, b: str, decision: str, review_item_id: str | None, actor: str) -> None:
        self._exec(
            "insert into knowledge.merge_decision (a, b, decision, review_item_id, actor) "
            "values (least(%s::uuid, %s::uuid), greatest(%s::uuid, %s::uuid), %s, %s::uuid, %s) "
            "on conflict (a, b) do update set decision = excluded.decision, review_item_id = excluded.review_item_id, "
            "actor = excluded.actor, decided_at = now()",
            (a, b, a, b, decision, review_item_id, actor),
        )

    def db_suppressed(self, hashes: list[str]) -> set[str]:
        present = self._one("select to_regclass('knowledge.suppression') is not null as present")
        if not present or not present["present"]:
            return set()
        rows = self._all("select hash from knowledge.suppression where hash = any(%s)", (hashes,))
        return {r["hash"] for r in rows}

    def emit(self, type: str, payload: Mapping[str, Any]) -> str:
        return queue_emit(self.conn, type, dict(payload))

    def enqueue(self, type: str, payload: Mapping[str, Any], idempotency_key: str, run_at: datetime | None) -> str:
        return queue_enqueue(self.conn, type=type, queue="knowledge", payload=dict(payload),
                             idempotency_key=idempotency_key, run_at=run_at)


# ---- in-memory -------------------------------------------------------------------------------

class MemoryEvidenceRepo(EvidenceRepo):
    """Dictionary-backed implementation with the same semantics (tests, offline tools)."""

    def __init__(self) -> None:
        self.companies: dict[str, Company] = {}
        self.anchors: dict[tuple[str, str], str] = {}
        self.assertions: dict[str, Assertion] = {}
        self.contact_values: dict[str, ContactValue] = {}
        self.search_docs: dict[tuple[str, str], dict[str, Any]] = {}
        self.profile_docs: dict[str, dict[str, Any]] = {}
        self.merge_decisions: dict[tuple[str, str], dict[str, Any]] = {}
        self.suppression: set[str] = set()
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.jobs: dict[tuple[str, str], dict[str, Any]] = {}

    def get_company(self, company_id: str) -> Company | None:
        c = self.companies.get(str(company_id))
        return c.model_copy() if c else None

    def insert_company(self, c: Company) -> None:
        if c.id in self.companies:
            raise KpError("CONFLICT", f"company {c.id} already exists")
        self.companies[c.id] = c.model_copy()

    def update_company(self, company_id: str, fields: Mapping[str, Any]) -> None:
        bad = set(fields) - _COMPANY_UPDATABLE
        if bad:
            raise KpError("VALIDATION", f"company fields not updatable: {', '.join(sorted(bad))}")
        c = self.companies.get(company_id)
        if c is not None:
            self.companies[company_id] = c.model_copy(update={**fields, "updated_at": datetime.now(timezone.utc)})

    def get_anchor(self, kind: str, value_norm: str) -> str | None:
        return self.anchors.get((kind, value_norm))

    def insert_anchor(self, kind: str, value_norm: str, company_id: str) -> None:
        if kind not in ANCHOR_KINDS:
            raise KpError("VALIDATION", f"unknown anchor kind {kind}")
        existing = self.anchors.get((kind, value_norm))
        if existing is not None and existing != company_id:
            raise AnchorConflict(kind, value_norm, existing)
        self.anchors[(kind, value_norm)] = company_id

    def anchors_of(self, company_id: str) -> list[tuple[str, str]]:
        return sorted(k for k, v in self.anchors.items() if v == company_id)

    def move_anchors(self, from_id: str, to_id: str) -> None:
        for k, v in list(self.anchors.items()):
            if v == from_id:
                self.anchors[k] = to_id

    def get_assertion(self, assertion_id: str) -> Assertion | None:
        a = self.assertions.get(assertion_id)
        return a.model_copy(deep=True) if a else None

    def active_assertions(self, subject_id: str, attribute: str, polarity: str) -> list[Assertion]:
        return sorted(
            (a.model_copy(deep=True) for a in self.assertions.values()
             if a.subject_id == subject_id and a.attribute == attribute and a.polarity == polarity
             and a.superseded_by is None),
            key=lambda a: a.created_at,
        )

    def list_assertions(self, subject_id: str, attributes: list[str] | None,
                        include_superseded: bool) -> list[Assertion]:
        wanted = set(attributes) if attributes is not None else None
        out = [a.model_copy(deep=True) for a in self.assertions.values()
               if a.subject_id == subject_id and (wanted is None or a.attribute in wanted)
               and (include_superseded or a.superseded_by is None)]
        return sorted(out, key=lambda a: (a.attribute, a.created_at))

    def insert_assertion(self, a: Assertion) -> None:
        if a.id in self.assertions:
            raise KpError("CONFLICT", f"assertion {a.id} already exists")
        self.assertions[a.id] = a.model_copy(deep=True)

    def mark_superseded(self, ids: list[str], by: str) -> None:
        for i in ids:
            a = self.assertions.get(i)
            if a is not None and a.superseded_by is None:
                self.assertions[i] = a.model_copy(update={"superseded_by": by})

    def touch_checked_at(self, assertion_id: str, checked_at: datetime) -> None:
        a = self.assertions.get(assertion_id)
        if a is not None:
            self.assertions[assertion_id] = a.model_copy(update={"checked_at": max(a.checked_at, checked_at)})

    def repoint_assertions(self, from_id: str, to_id: str) -> int:
        n = 0
        for i, a in list(self.assertions.items()):
            if a.subject_id == from_id:
                self.assertions[i] = a.model_copy(update={"subject_id": to_id})
                n += 1
        return n

    def stale(self, attribute_prefix: str, cutoff: datetime, limit: int) -> list[Assertion]:
        out = [a for a in self.assertions.values()
               if a.attribute.startswith(attribute_prefix) and a.checked_at < cutoff and a.superseded_by is None
               and a.polarity == "positive"]
        return [a.model_copy(deep=True) for a in sorted(out, key=lambda a: a.checked_at)[:limit]]

    def put_contact_value(self, cv: ContactValue) -> None:
        self.contact_values[cv.assertion_id] = cv.model_copy()

    def purge_contact_values(self, hashes: list[str]) -> list[str]:
        hs = set(hashes)
        hit = [k for k, v in self.contact_values.items() if v.value_hash in hs]
        companies = [self.contact_values[k].company_id for k in hit]
        for k in hit:
            del self.contact_values[k]
        return list(dict.fromkeys(companies))

    def repoint_contact_values(self, from_id: str, to_id: str) -> None:
        for k, v in list(self.contact_values.items()):
            if v.company_id == from_id:
                self.contact_values[k] = v.model_copy(update={"company_id": to_id})

    def replace_search_docs(self, company_id: str, rows: list[dict[str, Any]]) -> None:
        self.delete_search_docs(company_id)
        for r in rows:
            self.search_docs[(company_id, r["hs_heading"])] = copy.deepcopy(r)

    def delete_search_docs(self, company_id: str) -> None:
        for k in [k for k in self.search_docs if k[0] == company_id]:
            del self.search_docs[k]

    def upsert_profile_doc(self, row: dict[str, Any]) -> None:
        self.profile_docs[row["company_id"]] = copy.deepcopy(row)

    def delete_profile_doc(self, company_id: str) -> None:
        self.profile_docs.pop(company_id, None)

    def companies_for_hashes(self, hashes: list[str]) -> list[str]:
        hs = set(hashes)
        out: list[str] = []
        for cid, row in self.profile_docs.items():
            if hs & set(row["identifier_hashes"]):
                out.append(cid)
        for (cid, _), row in self.search_docs.items():
            if hs & set(row["identifier_hashes"]):
                out.append(cid)
        out.extend(v.company_id for v in self.contact_values.values() if v.value_hash in hs)
        return list(dict.fromkeys(out))

    def record_merge_decision(self, a: str, b: str, decision: str, review_item_id: str | None, actor: str) -> None:
        lo, hi = sorted((a, b))
        self.merge_decisions[(lo, hi)] = {"decision": decision, "review_item_id": review_item_id, "actor": actor}

    def db_suppressed(self, hashes: list[str]) -> set[str]:
        return set(hashes) & self.suppression

    def emit(self, type: str, payload: Mapping[str, Any]) -> str:
        # Round-trip through JSON so tests see exactly what the outbox would store.
        self.events.append((type, json.loads(json.dumps(dict(payload), default=str))))
        return f"evt-{len(self.events)}"

    def enqueue(self, type: str, payload: Mapping[str, Any], idempotency_key: str, run_at: datetime | None) -> str:
        key = (type, idempotency_key)
        if key not in self.jobs:
            self.jobs[key] = {"payload": dict(payload), "run_at": run_at}
        return f"job-{type}-{idempotency_key}"


def cutoff_for(older_than: timedelta, now: datetime | None = None) -> datetime:
    return (now or datetime.now(timezone.utc)) - older_than
