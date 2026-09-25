from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

import pytest

from kp.m01_platform import KpError
from kp.m08_sources import connector as connector_mod
from kp.m08_sources import (
    PROHIBITED_HOSTS,
    Connector,
    FetchRequest,
    HttpResponse,
    MemoryRawIndex,
    MemoryRawStore,
    RawItem,
    RawRef,
    Record,
    RobotsDisallowed,
    SourceNotActive,
    SourceNotRegistered,
    SourceStorageForbidden,
    build_lifecycle_rules,
    http_fetch,
    is_prohibited_host,
    load_register_file,
    register_drift,
    register_entries_loader,
    set_source_loader_for_testing,
    set_transport_for_testing,
    user_agent,
    validate_entry,
)
from kp.m08_sources.register import SourceEntry

REPO = Path(__file__).resolve().parents[3]


def _entry(**over: Any) -> SourceEntry:
    base: dict[str, Any] = {
        "id": "test.src", "source_type": "registry", "can_store": True, "can_display": True, "can_export": True,
        "retention_days": 30, "attribution_text": "Test attribution", "personal_data_class": "none",
        "allowed_regions": ["*"], "status": "active", "notes": None,
    }
    base.update(over)
    return validate_entry(base)


class _Budget:
    """Stands in for the M01 Redis budget flags and cost recorder inside the connector module."""

    def __init__(self) -> None:
        self.exceeded: set[str] = set()
        self.costs: list[dict[str, Any]] = []

    def is_exceeded(self, vendor: str) -> bool:
        return vendor in self.exceeded

    def assert_budget(self, vendor: str) -> None:
        if vendor in self.exceeded:
            raise KpError("UPSTREAM_UNAVAILABLE", f"{vendor} is temporarily unavailable",
                          {"vendor": vendor, "reason": "budget_exceeded"})

    def record(self, **kw: Any) -> None:
        self.costs.append(kw)


@pytest.fixture(autouse=True)
def _isolation(monkeypatch: pytest.MonkeyPatch) -> Iterable[_Budget]:
    b = _Budget()
    monkeypatch.setattr(connector_mod, "is_budget_exceeded", b.is_exceeded)
    monkeypatch.setattr(connector_mod, "assert_vendor_budget", b.assert_budget)
    monkeypatch.setattr(connector_mod, "record_cost", b.record)
    yield b
    set_source_loader_for_testing(None)
    set_transport_for_testing(None)


def _use(*entries: SourceEntry) -> None:
    set_source_loader_for_testing(register_entries_loader(entries))


class _Conn(Connector):
    source_id = "test.src"
    rate_class = "test"

    def __init__(self, items: list[RawItem], **kw: Any) -> None:
        super().__init__(**kw)
        self._items = items

    def fetch(self, req: FetchRequest) -> Iterable[RawItem]:
        yield from self._items

    def parse(self, ref: RawRef) -> Iterable[Record]:
        body = self.body_of(ref).decode()
        region, _, name = body.partition(":")
        yield self.record(ref, attribute="name", value=name, subject={"name": name}, region=region)


# ---- the two tests named by the LLD -------------------------------------------------------

def test_constructing_with_unregistered_or_prohibited_source_raises() -> None:
    _use()  # empty register
    with pytest.raises(SourceNotRegistered):
        _Conn([])

    _use(_entry(status="disabled"))
    with pytest.raises(SourceNotActive):
        _Conn([])

    class LinkedIn(_Conn):
        source_id = "linkedin"

    _use(_entry(id="linkedin", status="prohibited", can_store=False, can_display=False, can_export=False))
    with pytest.raises(SourceNotActive) as ei:
        LinkedIn([])
    assert ei.value.code == "POLICY_DENIED"


def test_landing_same_bytes_twice_produces_one_object() -> None:
    _use(_entry())
    store, index = MemoryRawStore(), MemoryRawIndex()
    c = _Conn([], store=store, index=index)
    t = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    a = c.land(RawItem(body=b"GB:Acme", fetched_at=t))
    b = c.land(RawItem(body=b"GB:Acme", fetched_at=datetime(2026, 9, 26, tzinfo=timezone.utc)))
    assert a.raw_object_id == b.raw_object_id and a.s3_key == b.s3_key
    assert len(store.objects) == 1 and len(index.rows) == 1
    assert a.s3_key == f"test.src/2026/09/25/{a.sha256}"
    assert a.expires_at == datetime(2026, 10, 25, 10, 0, tzinfo=timezone.utc)


# ---- run / licence enforcement --------------------------------------------------------------

def test_run_stamps_licence_terms_and_blocks_regions() -> None:
    _use(_entry(can_export=False, allowed_regions=["GB"], attribution_text="OGL v3.0"))
    out: list[Record] = []
    c = _Conn([RawItem(body=b"GB:Acme"), RawItem(body=b"US:Other"), RawItem(body=b"GB:Acme")],
              store=MemoryRawStore(), index=MemoryRawIndex(), sink=out.append)
    stats = c.run(FetchRequest())
    assert (stats.fetched, stats.landed, stats.deduplicated, stats.region_blocked) == (3, 2, 1, 1)
    assert len(out) == 2
    assert all(r.attribution_text == "OGL v3.0" and r.can_display and not r.can_export for r in out)
    assert out[0].source_ref["raw_object_id"]


def test_can_store_false_processes_in_memory_only() -> None:
    _use(_entry(can_store=False))
    store, index = MemoryRawStore(), MemoryRawIndex()
    out: list[Record] = []
    c = _Conn([RawItem(body=b"IN:Kumar Exports")], store=store, index=index, sink=out.append)
    with pytest.raises(SourceStorageForbidden):
        c.land(RawItem(body=b"x"))
    stats = c.run(FetchRequest())
    assert stats.in_memory == 1 and stats.records == 1
    assert not store.objects and not index.rows
    assert "raw_object_id" not in out[0].source_ref


def test_run_records_cost_and_refuses_when_budget_flag_set(_isolation: _Budget) -> None:
    _use(_entry())
    c = _Conn([RawItem(body=b"GB:A", cost_micros_inr=250)], store=MemoryRawStore(), index=MemoryRawIndex(),
              sink=lambda r: None)
    c.run(FetchRequest())
    assert _isolation.costs[-1]["vendor"] == "test.src" and _isolation.costs[-1]["cost_micros_inr"] == 250
    _isolation.exceeded.add("test.src")
    with pytest.raises(KpError) as ei:
        c.run(FetchRequest())
    assert ei.value.code == "UPSTREAM_UNAVAILABLE"


def test_run_rechecks_register_status() -> None:
    _use(_entry())
    c = _Conn([], sink=lambda r: None, store=MemoryRawStore(), index=MemoryRawIndex())
    _use(_entry(status="disabled"))
    with pytest.raises(SourceNotActive):
        c.run(FetchRequest())


# ---- http helper -------------------------------------------------------------------------------

def test_http_fetch_checks_robots_and_identifies_itself() -> None:
    seen: list[tuple[str, Mapping[str, str]]] = []

    def transport(method: str, url: str, headers: Mapping[str, str], timeout: float) -> HttpResponse:
        seen.append((url, headers))
        if url.endswith("/robots.txt"):
            return HttpResponse(url, 200, {}, b"User-agent: *\nDisallow: /private\n")
        return HttpResponse(url, 200, {"content-type": "text/html"}, b"ok")

    set_transport_for_testing(transport)
    assert http_fetch("https://example.com/about").body == b"ok"
    assert seen[-1][1]["user-agent"] == user_agent() and "+http" in user_agent()
    skipped: list[str] = []
    with pytest.raises(RobotsDisallowed):
        http_fetch("https://example.com/private/x", on_skip=skipped.append)
    assert skipped == ["https://example.com/private/x"]


def test_robots_disallow_counts_as_skipped_in_run() -> None:
    _use(_entry(id="web.test"))

    def transport(method: str, url: str, headers: Mapping[str, str], timeout: float) -> HttpResponse:
        if url.endswith("/robots.txt"):
            return HttpResponse(url, 200, {}, b"User-agent: *\nDisallow: /no\n")
        return HttpResponse(url, 200, {}, b"GB:Fetched")

    set_transport_for_testing(transport)

    class Web(Connector):
        source_id = "web.test"
        rate_class = "web"

        def fetch(self, req: FetchRequest) -> Iterable[RawItem]:
            for path in ("/yes", "/no", "/yes2"):
                try:
                    r = self.http_fetch("https://site.example" + path)
                except RobotsDisallowed:
                    continue
                yield RawItem(body=r.body + path.encode(), url=r.url)

        def parse(self, ref: RawRef) -> Iterable[Record]:
            yield self.record(ref, attribute="page", value=ref.url, subject={}, region="GB")

    stats = Web(store=MemoryRawStore(), index=MemoryRawIndex(), sink=lambda r: None).run(FetchRequest())
    assert (stats.fetched, stats.skipped, stats.records) == (2, 1, 2)


def test_prohibited_hosts() -> None:
    assert is_prohibited_host("www.linkedin.com") and is_prohibited_host("LinkedIn.com.")
    assert not is_prohibited_host("notlinkedin.com")


# ---- register file, seed migration, lifecycle -----------------------------------------------

def _sql_literals(tuple_text: str) -> list[Any]:
    tokens = re.findall(r"'((?:[^']|'')*)'|(array\[[^\]]*\](?:::text\[\])?)|\b(true|false|null|\d+)\b", tuple_text)
    out: list[Any] = []
    for s, arr, word in tokens:
        if arr:
            out.append(re.findall(r"'([^']*)'", arr))
        elif word:
            out.append({"true": True, "false": False, "null": None}.get(word, int(word) if word.isdigit() else word))
        else:
            out.append(s.replace("''", "'"))
    return out


def test_register_file_matches_seed_migration() -> None:
    entries = load_register_file(REPO / "config" / "sources.yaml")
    ids = {e.id for e in entries}
    assert "linkedin" in ids
    assert next(e for e in entries if e.id == "linkedin").status == "prohibited"
    prohibited_domains = {d for e in entries if e.status == "prohibited" for d in e.domains}
    assert prohibited_domains == set(PROHIBITED_HOSTS)

    sql = (REPO / "db" / "migrations" / "0008_m08_source_register.sql").read_text()
    seeded: list[SourceEntry] = []
    for line in sql.splitlines():
        line = line.strip()
        if not line.startswith("('"):
            continue
        v = _sql_literals(line.rstrip(","))
        seeded.append(validate_entry({
            "id": v[0], "source_type": v[1], "can_store": v[2], "can_display": v[3], "can_export": v[4],
            "retention_days": v[5], "attribution_text": v[6], "personal_data_class": v[7], "allowed_regions": v[8],
            "status": v[9], "notes": v[10],
        }))
    assert register_drift(seeded, entries) == []


def test_lifecycle_rules_follow_retention() -> None:
    rules = build_lifecycle_rules([_entry(id="a.one", retention_days=30), _entry(id="b.two", retention_days=None)])
    assert [r["ID"] for r in rules] == ["m08-baseline", "m08-src-a.one"]
    assert rules[1]["Filter"] == {"Prefix": "a.one/"} and rules[1]["Expiration"] == {"Days": 30}


def test_validate_entry_rejects_bad_rows() -> None:
    with pytest.raises(KpError):
        _entry(status="prohibited")  # prohibited with rights
    with pytest.raises(KpError):
        _entry(can_display=False, can_export=True)
    with pytest.raises(KpError):
        _entry(id="linkedin")  # permanently prohibited id marked active
    with pytest.raises(KpError):
        _entry(allowed_regions=["Britain"])
