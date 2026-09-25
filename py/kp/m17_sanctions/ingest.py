"""M17 daily ingestion of the sanctions lists (M08 connectors).

Sources (config/sources.yaml): sanctions.us.ofac (SDN + consolidated non-SDN), sanctions.un.sc,
sanctions.eu.fsf, sanctions.gb.ofsi. Each connector fetches its file(s), lands them raw (all four
sources have can_store = true), and parses them into ``sanctions.entry`` records. The ingest then
diffs each list by (list, list_uid) in one transaction per list and, on any change, emits EV-02
``sanctions.list_changed`` which triggers the batched re-screen.

A list whose parse is empty, or shrinks below MIN_RETAINED_FRACTION of the active entries, is not
applied (a truncated or broken download must never delist everyone); the run reports it and the
job retries.

URLs can be overridden with KP_SANCTIONS_<LIST>_URL (e.g. KP_SANCTIONS_OFAC_SDN_URL).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Callable, ClassVar, ContextManager, Iterable, Sequence

from kp.m01_platform import KpError, get_logger, span
from kp.m08_sources import Connector, FetchRequest, RawItem, RawRef, Record

from .models import LIST_KEYS, LIST_SOURCE, DiffStats, ParsedEntry
from .parsers import parse_list
from .store import PgSanctionsStore, SanctionsStore

_log = get_logger("kp.m17_sanctions.ingest")

EV_LISTS_CHANGED = "sanctions.list_changed"   # EV-02 {lists, list_versions, changed_entry_count}
RECORD_ATTRIBUTE = "sanctions.entry"
RATE_CLASS = "m17.sanctions"
MIN_RETAINED_FRACTION = 0.5    # [tunable]
FETCH_TIMEOUT_S = 180.0

DEFAULT_URLS: dict[str, str] = {
    "ofac_sdn": "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML",
    "ofac_cons": "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML",
    "un": "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
    "eu": "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw",
    "uk_ofsi": "https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv",
}
_CONTENT_TYPES = {"uk_ofsi": "text/csv"}


def list_url(list_key: str) -> str:
    return os.environ.get(f"KP_SANCTIONS_{list_key.upper()}_URL") or DEFAULT_URLS[list_key]


class _SanctionsConnector(Connector):
    """params: {"lists": [list keys served by this source]}"""

    rate_class: ClassVar[str] = RATE_CLASS
    lists: ClassVar[tuple[str, ...]] = ()

    def fetch(self, req: FetchRequest) -> Iterable[RawItem]:
        wanted = [k for k in (req.params.get("lists") or self.lists) if k in self.lists]
        for key in wanted:
            url = list_url(key)
            resp = self.http_fetch(url, timeout=FETCH_TIMEOUT_S)
            hops = 0
            while resp.status in (301, 302, 303, 307, 308) and hops < 3 and resp.headers.get("location"):
                hops += 1
                resp = self.http_fetch(resp.headers["location"], timeout=FETCH_TIMEOUT_S)
            if resp.status == 429 or resp.status >= 500:
                raise KpError("UPSTREAM_UNAVAILABLE", f"{key} list returned HTTP {resp.status}", {"url": url})
            if resp.status >= 400 or not resp.body:
                raise KpError("UPSTREAM_UNAVAILABLE", f"{key} list could not be downloaded (HTTP {resp.status})",
                              {"url": url})
            yield RawItem(body=resp.body, content_type=_CONTENT_TYPES.get(key, "application/xml"), url=url,
                          meta={"list": key})

    def parse(self, ref: RawRef) -> Iterable[Record]:
        key = str(ref.meta.get("list", ""))
        if key not in self.lists:
            raise KpError("INTERNAL", f"raw item for unknown list {key!r}")
        entries, version = parse_list(key, self.body_of(ref))
        list_version = version or ref.sha256
        for p in entries:
            yield self.record(
                ref, attribute=RECORD_ATTRIBUTE,
                value={"names": list(p.names), "countries": list(p.countries), "entity_type": p.entity_type,
                       "list_version": list_version},
                subject={"list": key, "list_uid": p.list_uid},
                extra_ref={"list": key, "list_version": list_version},
            )


class OfacConnector(_SanctionsConnector):
    source_id: ClassVar[str] = LIST_SOURCE["ofac_sdn"]
    vendor: ClassVar[str | None] = "ofac"
    lists: ClassVar[tuple[str, ...]] = ("ofac_sdn", "ofac_cons")


class UnConnector(_SanctionsConnector):
    source_id: ClassVar[str] = LIST_SOURCE["un"]
    vendor: ClassVar[str | None] = "un_sc"
    lists: ClassVar[tuple[str, ...]] = ("un",)


class EuConnector(_SanctionsConnector):
    source_id: ClassVar[str] = LIST_SOURCE["eu"]
    vendor: ClassVar[str | None] = "eu_fsf"
    lists: ClassVar[tuple[str, ...]] = ("eu",)


class UkOfsiConnector(_SanctionsConnector):
    source_id: ClassVar[str] = LIST_SOURCE["uk_ofsi"]
    vendor: ClassVar[str | None] = "uk_ofsi"
    lists: ClassVar[tuple[str, ...]] = ("uk_ofsi",)


CONNECTORS: tuple[type[_SanctionsConnector], ...] = (OfacConnector, UnConnector, EuConnector, UkOfsiConnector)


@dataclass
class ListBatch:
    list: str
    list_version: str | None = None
    entries: list[ParsedEntry] = field(default_factory=list)


def entry_from_record(rec: Record) -> tuple[str, str, ParsedEntry] | None:
    """(list, list_version, entry) from a connector record, or None for other records."""
    if rec.attribute != RECORD_ATTRIBUTE:
        return None
    try:
        key = str(rec.subject["list"])
        v = rec.value
        return key, str(v["list_version"]), ParsedEntry(
            list=key, list_uid=str(rec.subject["list_uid"]), names=tuple(str(n) for n in v["names"]),
            countries=tuple(str(c) for c in v.get("countries") or ()), entity_type=str(v.get("entity_type") or "unknown"))
    except (KeyError, TypeError, ValueError):
        return None


@dataclass
class IngestReport:
    applied: list[DiffStats] = field(default_factory=list)
    rejected: dict[str, str] = field(default_factory=dict)
    failed_sources: dict[str, str] = field(default_factory=dict)

    @property
    def changed_lists(self) -> list[str]:
        return [d.list for d in self.applied if d.any_change]

    def as_dict(self) -> dict[str, Any]:
        return {"applied": [{"list": d.list, "version": d.list_version, "entries": d.entry_count, "added": d.added,
                             "changed": d.changed, "removed": d.removed} for d in self.applied],
                "rejected": self.rejected, "failed_sources": self.failed_sources}


def collect(lists: Sequence[str], *, correlation_id: str | None = None,
            connectors: Sequence[type[_SanctionsConnector]] = CONNECTORS,
            report: IngestReport | None = None) -> dict[str, ListBatch]:
    """Runs the connectors for ``lists`` and gathers the parsed entries per list."""
    rep = report if report is not None else IngestReport()
    batches: dict[str, ListBatch] = {}

    def sink(rec: Record) -> None:
        got = entry_from_record(rec)
        if got is None:
            return
        key, version, entry = got
        b = batches.setdefault(key, ListBatch(list=key))
        b.list_version = version
        b.entries.append(entry)

    for cls in connectors:
        mine = [k for k in lists if k in cls.lists]
        if not mine:
            continue
        # Each list is one raw item, parsed completely before the next is fetched, so a list is
        # either fully present in ``batches`` or absent; a failed or skipped list is never
        # applied from a partial read.
        try:
            stats = cls().run(FetchRequest(params={"lists": mine}, correlation_id=correlation_id), sink)
            for k in mine:
                if k not in batches:
                    rep.failed_sources[k] = (f"{cls.source_id}: {stats.errors} item error(s)" if stats.errors
                                             else f"{cls.source_id}: nothing fetched (skipped={stats.skipped})")
        except KpError as e:
            for k in mine:
                if k not in batches:
                    rep.failed_sources[k] = f"{e.code}: {e}"
            _log.warning("sanctions source failed", extra={"source_id": cls.source_id, "code": e.code})
    return batches


def apply_batches(batches: dict[str, ListBatch], tx_factory: Callable[[], ContextManager[Any]],
                  *, store_factory: Callable[[Any], SanctionsStore] = PgSanctionsStore,
                  emit_changed: Callable[[Any, dict[str, Any]], None] | None = None,
                  report: IngestReport | None = None) -> IngestReport:
    """Applies each list in its own transaction; EV-02 is emitted in the last applying
    transaction that saw a change (one event per run)."""
    rep = report if report is not None else IngestReport()
    for key in LIST_KEYS:
        b = batches.get(key)
        if b is None:
            continue
        version = b.list_version or "unknown"
        with tx_factory() as tx:
            store = store_factory(tx)
            active = store.active_count(key)
            if not b.entries:
                rep.rejected[key] = "empty parse"
                continue
            if active and len({e.list_uid for e in b.entries}) < active * MIN_RETAINED_FRACTION:
                rep.rejected[key] = f"only {len(b.entries)} entries against {active} active; not applied"
                continue
            with span("m17.apply_list", {"list": key}):
                stats = store.apply_list(key, version, b.entries)
            rep.applied.append(stats)
    changed = rep.changed_lists
    if changed and emit_changed is not None:
        payload = {"lists": changed,
                   "list_versions": {d.list: d.list_version for d in rep.applied},
                   "changed_entry_count": sum(len(d.changed_entry_ids) for d in rep.applied)}
        with tx_factory() as tx:
            emit_changed(tx, payload)
    for key, why in rep.rejected.items():
        _log.error("sanctions list not applied", extra={"list": key, "reason": why})
    return rep
