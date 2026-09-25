"""M12 loaders (``Connector`` subclasses, IF-08b): WCO HS tables, DGFT ITC-HS schedules and
correlation tables.

Each loader fetches one file (URL from the job payload), lands it through the M08 framework
(licence register check, immutable raw landing, cost metrics), parses it into ``hs.code`` /
``hs.correlation`` records, validates the whole table, embeds descriptions through M03 and then
writes the version in one transaction (see ``store.PgHsStore``). Any problem fails the load and
nothing is written.
"""
from __future__ import annotations

import re
from abc import abstractmethod
from typing import Any, ClassVar, Iterable, Iterator

from kp.m01_platform import KpError, get_logger
from kp.m08_sources import Connector, FetchRequest, RawItem, RawRef, Record, RunStats

from .embeddings import EmbedFn, embed_rows
from .models import (
    ITCHS_SOURCE_ID,
    WCO_SOURCE_ID,
    CorrelationPair,
    CorrelationRow,
    HsCodeRow,
    HsLoadError,
    VersionLoadResult,
    assert_version,
    corresponding_hs_version,
    derive_relations,
    merge_duplicates,
    validate_hs_tree,
    validate_national_lines,
    version_family,
)
from .parsers import parse_correlation_table, parse_itchs_schedule, parse_wco_table, read_tables
from .store import HsStore

RATE_CLASS = "nomenclature"
FETCH_TIMEOUT_S = 120.0
_URL_RE = re.compile(r"^https?://", re.IGNORECASE)

_log = get_logger("kp.m12_hs.loaders")


class _TableFileConnector(Connector):
    """Fetches the single file named by ``req.params['url']`` and remembers parse failures so a
    load can report them (the base ``run`` only counts item errors)."""

    rate_class: ClassVar[str] = RATE_CLASS

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._parse_error: BaseException | None = None
        self.parse_problems: list[str] = []

    def fetch(self, req: FetchRequest) -> Iterable[RawItem]:
        url = req.params.get("url")
        if not isinstance(url, str) or not _URL_RE.match(url):
            raise KpError("VALIDATION", "a nomenclature load needs an http(s) 'url' parameter", {"url": url})
        resp = self.http_fetch(url, timeout=FETCH_TIMEOUT_S)
        if resp.status >= 400:
            raise KpError("UPSTREAM_UNAVAILABLE", f"fetching {url} returned HTTP {resp.status}",
                          {"url": url, "status": resp.status})
        yield RawItem(body=resp.body, content_type=resp.content_type, url=resp.url or url,
                      meta={"status": resp.status})

    def parse(self, ref: RawRef) -> Iterable[Record]:
        try:
            return list(self._parse(ref))
        except BaseException as e:
            self._parse_error = e
            raise

    @abstractmethod
    def _parse(self, ref: RawRef) -> Iterable[Record]:
        """Parses the landed file into records (implemented by each loader)."""

    def collect(self, url: str, correlation_id: str | None) -> list[Record]:
        """run() over one URL, returning the records or raising the reason the file was unusable."""
        self._parse_error = None
        self.parse_problems = []
        records: list[Record] = []
        stats = self.run(FetchRequest(params={"url": url}, correlation_id=correlation_id), sink=records.append)
        self._raise_if_failed(stats, url)
        return records

    def _raise_if_failed(self, stats: RunStats, url: str) -> None:
        if self._parse_error is not None:
            raise self._parse_error
        if stats.budget_stopped:
            raise KpError("UPSTREAM_UNAVAILABLE", f"vendor budget exhausted for {self.vendor_name}",
                          {"reason": "budget_exceeded", "url": url})
        if stats.skipped:
            raise KpError("UPSTREAM_UNAVAILABLE", f"{url} may not be fetched (robots.txt or prohibited host)",
                          {"url": url})
        if stats.errors:
            raise KpError("UPSTREAM_UNAVAILABLE", f"{url} could not be processed; see the connector log", {"url": url})
        if stats.fetched == 0:
            raise KpError("UPSTREAM_UNAVAILABLE", f"nothing was fetched from {url}", {"url": url})
        if stats.region_blocked:
            raise KpError("POLICY_DENIED", "nomenclature records were blocked by the source's allowed regions",
                          {"blocked": stats.region_blocked})

    def _code_records(self, ref: RawRef, rows: Iterable[HsCodeRow]) -> Iterator[Record]:
        for r in rows:
            yield self.record(ref, attribute="hs.code", value=r.as_value(), subject={"version": r.version, "code": r.code})


def _finish_version_load(
    version: str,
    rows: list[HsCodeRow],
    store: HsStore,
    *,
    make_current: bool,
    embed_fn: EmbedFn | None,
    correlation_id: str | None,
    warnings: list[str],
) -> VersionLoadResult:
    result = VersionLoadResult(version=version, codes=len(rows), warnings=list(warnings))
    reuse = store.embeddings_by_text(version) if store.version_exists(version) else {}
    embedded, reused, emb_warnings = embed_rows(rows, reuse=reuse, embed_fn=embed_fn, correlation_id=correlation_id)
    result.embedded, result.embeddings_reused = embedded, reused
    result.embeddings_skipped = len(emb_warnings)
    result.warnings.extend(emb_warnings)
    result.event_id = store.replace_version(version, rows, make_current=make_current)
    result.made_current = make_current
    _log.info("nomenclature version load finished", extra={"version": version, "codes": len(rows),
                                                            "embedded": embedded, "reused": reused})
    return result


class WcoHsLoader(_TableFileConnector):
    """WCO HS nomenclature (chapters, headings, subheadings) for ``HS2022``, ``HS2027``, …"""

    source_id: ClassVar[str] = WCO_SOURCE_ID

    def __init__(self, version: str, **kwargs: Any) -> None:
        self.version = assert_version(version, "HS")
        super().__init__(**kwargs)

    def _parse(self, ref: RawRef) -> Iterable[Record]:
        body = self.body_of(ref)
        rows = parse_wco_table(read_tables(body, ref.content_type, ref.url), self.version)
        return list(self._code_records(ref, rows))

    def load(self, url: str, store: HsStore, *, make_current: bool = True, embed_fn: EmbedFn | None = None,
             correlation_id: str | None = None) -> VersionLoadResult:
        records = self.collect(url, correlation_id)
        rows, problems = merge_duplicates(HsCodeRow.from_value(r.value) for r in records)
        problems += validate_hs_tree(self.version, rows)
        if not rows:
            problems.append("the table contains no HS codes")
        if problems:
            raise HsLoadError(f"{self.version}: nomenclature table rejected", problems, version=self.version, url=url)
        return _finish_version_load(self.version, rows, store, make_current=make_current, embed_fn=embed_fn,
                                    correlation_id=correlation_id, warnings=[])


def itchs_version(edition: str | int) -> str:
    """2022 / '2022' / 'ITCHS2022' → 'ITCHS2022'."""
    text = str(edition).strip().upper()
    if re.fullmatch(r"[0-9]{4}", text):
        text = f"ITCHS{text}"
    return assert_version(text, "ITCHS")


class DgftItcHsLoader(_TableFileConnector):
    """DGFT ITC(HS) 8-digit schedule with export policy, conditions and source links."""

    source_id: ClassVar[str] = ITCHS_SOURCE_ID

    def __init__(self, edition: str | int, **kwargs: Any) -> None:
        self.version = itchs_version(edition)
        super().__init__(**kwargs)

    def _parse(self, ref: RawRef) -> Iterable[Record]:
        body = self.body_of(ref)
        rows, problems = parse_itchs_schedule(read_tables(body, ref.content_type, ref.url), self.version, ref.url)
        self.parse_problems.extend(problems)
        return list(self._code_records(ref, rows))

    def load(self, url: str, store: HsStore, *, make_current: bool = True, embed_fn: EmbedFn | None = None,
             correlation_id: str | None = None) -> VersionLoadResult:
        hs_version = corresponding_hs_version(self.version)
        if not store.version_exists(hs_version):
            raise HsLoadError(f"{self.version} needs {hs_version} to be loaded first (its 6-digit parents)",
                              version=self.version, hs_version=hs_version)
        records = self.collect(url, correlation_id)
        problems = list(self.parse_problems)
        rows, dup_problems = merge_duplicates(HsCodeRow.from_value(r.value) for r in records)
        problems += dup_problems
        problems += validate_national_lines(self.version, rows, store.subheadings(hs_version))
        if not rows:
            problems.append("the schedule contains no 8-digit ITC(HS) lines")
        if problems:
            raise HsLoadError(f"{self.version}: ITC(HS) schedule rejected", problems, version=self.version, url=url)
        missing_policy = sum(1 for r in rows if r.export_policy is None)
        warnings = [f"{missing_policy} lines have no export policy in the schedule"] if missing_policy else []
        return _finish_version_load(self.version, rows, store, make_current=make_current, embed_fn=embed_fn,
                                    correlation_id=correlation_id, warnings=warnings)


class CorrelationLoader(_TableFileConnector):
    """Correlation table between two nomenclature versions (e.g. WCO HS 2022 → HS 2027).

    Use ``CorrelationLoader.for_versions(...)``: WCO tables are attributed to the WCO source,
    tables between ITC-HS editions to the DGFT source. Relations are derived from the table's
    cardinalities (``models.derive_relations``).
    """

    source_id: ClassVar[str] = WCO_SOURCE_ID

    def __init__(self, from_version: str, to_version: str, **kwargs: Any) -> None:
        version_family(from_version)
        version_family(to_version)
        if from_version == to_version:
            raise KpError("VALIDATION", "a correlation table links two different versions")
        self.from_version = from_version
        self.to_version = to_version
        super().__init__(**kwargs)

    @staticmethod
    def for_versions(from_version: str, to_version: str, **kwargs: Any) -> "CorrelationLoader":
        if version_family(from_version) == "ITCHS" and version_family(to_version) == "ITCHS":
            return ItcHsCorrelationLoader(from_version, to_version, **kwargs)
        return CorrelationLoader(from_version, to_version, **kwargs)

    def _parse(self, ref: RawRef) -> Iterable[Record]:
        body = self.body_of(ref)
        pairs = parse_correlation_table(read_tables(body, ref.content_type, ref.url), self.from_version, self.to_version)
        return [
            self.record(ref, attribute="hs.correlation", value={"from_code": p.from_code, "to_code": p.to_code},
                        subject={"from_version": self.from_version, "to_version": self.to_version, "code": p.from_code})
            for p in pairs
        ]

    def _known_codes(self, store: HsStore, version: str) -> set[str]:
        codes = store.existing_codes(version)
        if version_family(version) == "ITCHS":
            codes |= store.existing_codes(corresponding_hs_version(version))
        return codes

    def load(self, url: str, store: HsStore, *, correlation_id: str | None = None) -> int:
        for v in (self.from_version, self.to_version):
            if not store.version_exists(v):
                raise HsLoadError(f"{v} must be loaded before its correlation table", version=v)
        records = self.collect(url, correlation_id)
        pairs = [CorrelationPair(str(r.value["from_code"]), str(r.value["to_code"])) for r in records]
        if not pairs:
            raise HsLoadError(f"{self.from_version} → {self.to_version}: the table contains no code pairs", url=url)
        known_from = self._known_codes(store, self.from_version)
        known_to = self._known_codes(store, self.to_version)
        problems = sorted({f"{p.from_code}: not in {self.from_version}" for p in pairs if p.from_code not in known_from})
        problems += sorted({f"{p.to_code}: not in {self.to_version}" for p in pairs if p.to_code not in known_to})
        if problems:
            raise HsLoadError(f"{self.from_version} → {self.to_version}: correlation table rejected", problems, url=url)
        rows: list[CorrelationRow] = derive_relations(self.from_version, self.to_version, pairs)
        return store.replace_correlations(self.from_version, self.to_version, rows)


class ItcHsCorrelationLoader(CorrelationLoader):
    """Correlation between two DGFT ITC(HS) editions."""

    source_id: ClassVar[str] = ITCHS_SOURCE_ID
