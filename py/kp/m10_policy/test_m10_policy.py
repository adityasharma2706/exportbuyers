"""M10 Python tests: the shared normalisation vectors (same file as the TS suite) and the client."""
from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pytest

from kp.m01_platform import KpError
from kp.m10_policy import any_suppressed, is_suppressed, norm_hash, normalise, set_connection_factory
from kp.m10_policy.psl import parse_psl, registrable_domain

_VECTORS = Path(__file__).resolve().parents[3] / "spec" / "normalisation" / "vectors.json"
VECTORS: list[dict[str, str]] = json.loads(_VECTORS.read_text(encoding="utf-8"))["vectors"]


def test_at_least_40_vectors() -> None:
    assert len(VECTORS) >= 40


@pytest.mark.parametrize("v", VECTORS, ids=[f"{v['kind']}:{v['raw']}" for v in VECTORS])
def test_shared_vector(v: dict[str, str]) -> None:
    if "error" in v:
        with pytest.raises(KpError) as ei:
            normalise(v["kind"], v["raw"])
        assert ei.value.code == v["error"]
        return
    assert normalise(v["kind"], v["raw"]) == v["normalised"]
    expected = hashlib.sha256(f"{v['kind']}:{v['normalised']}".encode("utf-8")).hexdigest()
    assert norm_hash(v["kind"], v["raw"]) == expected


def test_psl_exception_and_wildcard() -> None:
    rules = parse_psl("uk\nco.uk\n*.ck\n!www.ck\n")
    assert registrable_domain(rules, "a.b.example.co.uk") == "example.co.uk"
    assert registrable_domain(rules, "shop.foo.ck") == "shop.foo.ck"
    assert registrable_domain(rules, "a.www.ck") == "www.ck"
    assert registrable_domain(rules, "x.y.example.com") == "example.com"


class _FakeCursor:
    def __init__(self, table: set[str]) -> None:
        self.table = table
        self.rows: list[tuple[str]] = []

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def execute(self, sql: str, params: tuple[list[str]]) -> None:
        assert "knowledge.suppression" in sql
        self.rows = [(h,) for h in params[0] if h in self.table]

    def fetchall(self) -> list[tuple[str]]:
        return self.rows


class _FakeConn:
    def __init__(self, table: set[str]) -> None:
        self.table = table

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self.table)


def test_client_checks_the_list() -> None:
    table = {norm_hash("domain", "blocked.example.com")}

    @contextmanager
    def factory() -> Iterator[_FakeConn]:
        yield _FakeConn(table)

    set_connection_factory(factory)
    try:
        assert is_suppressed("domain", "https://www.Blocked.example.com/contact")
        assert not is_suppressed("domain", "open.example.org")
        h = norm_hash("email", "x@y.com")
        assert any_suppressed([h, *table]) == table
        assert any_suppressed(["not-a-hash"]) == set()
    finally:
        set_connection_factory(None)
