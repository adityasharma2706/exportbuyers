"""UN Comtrade batch ingestion (M08 connector, source ``market_stats.un.comtrade``).

Uses the Comtrade bulk API: for each reporter × year, a list call returns the final-data file(s)
(gzip'd tab-separated) holding all of the reporter's HS lines for that year; each file is landed
raw and parsed into importer-reported flows (flowCode M, all customs procedures, all transport
modes, no second partner) at HS6.

    list:  GET {base}/bulk/v1/get/C/{freq}/HS?reporterCode=<m49>&period=<yyyy>
           → {"data": [{"fileUrl": ..., "reporterCode": ..., "period": ...}, ...]}
    file:  GET <fileUrl>   (gzip, TSV with a header row)

The subscription key comes from the COMTRADE_API_KEY secret. ``freq`` is 'A' (annual). Monthly
files (freq 'M') are summed into their calendar year by the parser, so both are accepted.
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import os
from dataclasses import dataclass
from typing import Any, ClassVar, Iterable, Iterator, Mapping

from kp.m01_platform import KpError, get_logger, get_secret
from kp.m08_sources import Connector, FetchRequest, RawItem, RawRef, Record

from .countries import ISO2_TO_M49, partner_key, reporter_iso2

SOURCE_ID = "market_stats.un.comtrade"
RATE_CLASS = "m14.comtrade"
DEFAULT_BASE_URL = "https://comtradeapi.un.org"
FILE_TIMEOUT_S = 300.0
LIST_TIMEOUT_S = 60.0
ATTRIBUTE = "trade_flow"

_log = get_logger("kp.m14_markets.comtrade")


@dataclass(frozen=True)
class FlowRow:
    reporter: str
    partner: str
    hs6: str
    year: int
    value_usd: int
    qty: float | None


def base_url() -> str:
    return (os.environ.get("KP_COMTRADE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def _norm_header(h: str) -> str:
    return h.strip().strip("﻿").lower()


def _int(v: Any) -> int | None:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _float(v: Any) -> float | None:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _decompress(body: bytes) -> str:
    raw = gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body
    return raw.decode("utf-8-sig", errors="replace")


def parse_final_data(body: bytes) -> Iterator[FlowRow]:
    """Parses one Comtrade final-data file into import flows at HS6, summing duplicate keys
    (monthly periods and any remaining breakdowns) into (reporter, partner, hs6, year)."""
    text = _decompress(body)
    first = text.split("\n", 1)[0]
    dialect = "excel-tab" if first.count("\t") >= first.count(",") else "excel"
    reader = csv.reader(io.StringIO(text), dialect=dialect)
    try:
        header = [_norm_header(h) for h in next(reader)]
    except StopIteration:
        return
    col = {h: i for i, h in enumerate(header)}
    for needed in ("reportercode", "partnercode", "cmdcode", "primaryvalue"):
        if needed not in col:
            raise KpError("VALIDATION", f"Comtrade file has no {needed} column", {"columns": header[:40]})

    def get(r: list[str], name: str) -> str | None:
        i = col.get(name)
        return r[i] if i is not None and i < len(r) else None

    acc: dict[tuple[str, str, str, int], list[float | None]] = {}
    for r in reader:
        if not r:
            continue
        flow = (get(r, "flowcode") or "M").strip().upper()
        if flow != "M":
            continue
        # Totals only: no second partner, all customs procedures, all modes of transport.
        if (_int(get(r, "partner2code")) or 0) != 0:
            continue
        customs = (get(r, "customscode") or "C00").strip().upper()
        if customs not in ("C00", ""):
            continue
        if (_int(get(r, "motcode")) or 0) != 0:
            continue
        cmd = (get(r, "cmdcode") or "").strip()
        if len(cmd) != 6 or not cmd.isdigit():
            continue
        rep_m49 = _int(get(r, "reportercode"))
        par_m49 = _int(get(r, "partnercode"))
        if rep_m49 is None or par_m49 is None:
            continue
        reporter = reporter_iso2(rep_m49)
        if reporter is None:
            continue
        year = _int(get(r, "refyear"))
        if year is None:
            period = (get(r, "period") or "").strip()
            year = _int(period[:4]) if len(period) >= 4 else None
        if year is None:
            continue
        value = _float(get(r, "primaryvalue"))
        if value is None or value < 0:
            continue
        qty = _float(get(r, "qty"))
        key = (reporter, partner_key(par_m49), cmd, year)
        cur = acc.get(key)
        if cur is None:
            acc[key] = [value, qty]
        else:
            cur[0] = (cur[0] or 0.0) + value
            cur[1] = None if cur[1] is None or qty is None else cur[1] + qty
    for (reporter, partner, hs6, year), (value, qty) in acc.items():
        if partner == reporter:
            continue  # re-imports reported against itself are not a supplier market
        yield FlowRow(reporter=reporter, partner=partner, hs6=hs6, year=year,
                      value_usd=int(round(value or 0.0)), qty=qty)


class ComtradeConnector(Connector):
    """params: {"reporters": [ISO2, ...], "years": [yyyy, ...], "freq": "A"}"""

    source_id: ClassVar[str] = SOURCE_ID
    rate_class: ClassVar[str] = RATE_CLASS
    vendor: ClassVar[str | None] = "un_comtrade"

    def _headers(self) -> dict[str, str]:
        return {"Ocp-Apim-Subscription-Key": get_secret("COMTRADE_API_KEY"), "Accept": "application/json"}

    def _get(self, url: str, timeout: float, headers: Mapping[str, str]) -> bytes:
        resp = self.http_fetch(url, headers=headers, timeout=timeout)
        hops = 0
        while resp.status in (301, 302, 303, 307, 308) and hops < 3:
            loc = resp.headers.get("location")
            if not loc:
                break
            hops += 1
            # Signed download URLs must not receive the API key.
            resp = self.http_fetch(loc, timeout=timeout)
        if resp.status == 404:
            return b""
        if resp.status == 429 or resp.status >= 500:
            raise KpError("UPSTREAM_UNAVAILABLE", f"Comtrade returned HTTP {resp.status}", {"url": url})
        if resp.status >= 400:
            raise KpError("VALIDATION", f"Comtrade returned HTTP {resp.status}", {"url": url})
        return resp.body

    def file_urls(self, reporter: str, year: int, freq: str) -> list[str]:
        m49 = ISO2_TO_M49.get(reporter)
        if m49 is None:
            raise KpError("VALIDATION", f"Unknown reporter country {reporter}")
        url = f"{base_url()}/bulk/v1/get/C/{freq}/HS?reporterCode={m49}&period={year}"
        body = self._get(url, LIST_TIMEOUT_S, self._headers())
        if not body:
            return []
        try:
            doc = json.loads(body)
        except ValueError as e:
            raise KpError("UPSTREAM_UNAVAILABLE", "Comtrade file list is not JSON", {"url": url}) from e
        out: list[str] = []
        for d in (doc.get("data") or []) if isinstance(doc, dict) else []:
            u = d.get("fileUrl") if isinstance(d, dict) else None
            if isinstance(u, str) and u.lower().startswith(("http://", "https://")):
                out.append(u)
        return out

    def fetch(self, req: FetchRequest) -> Iterable[RawItem]:
        reporters = [str(r).upper() for r in req.params.get("reporters", [])]
        years = sorted({int(y) for y in req.params.get("years", [])})
        freq = str(req.params.get("freq", "A")).upper()
        if freq not in ("A", "M"):
            raise KpError("VALIDATION", "freq must be 'A' or 'M'")
        for reporter in reporters:
            for year in years:
                try:
                    urls = self.file_urls(reporter, year, freq)
                except KpError as e:
                    if e.code == "UPSTREAM_UNAVAILABLE":
                        raise
                    _log.warning("comtrade list failed", extra={"reporter": reporter, "year": year, "code": e.code})
                    continue
                if not urls:
                    _log.info("comtrade has no data yet", extra={"reporter": reporter, "year": year})
                for u in urls:
                    body = self._get(u, FILE_TIMEOUT_S, self._headers())
                    if body:
                        yield RawItem(body=body, content_type="application/gzip", url=u,
                                      meta={"reporter": reporter, "year": year, "freq": freq})

    def parse(self, ref: RawRef) -> Iterable[Record]:
        for f in parse_final_data(self.body_of(ref)):
            yield self.record(
                ref, attribute=ATTRIBUTE,
                value={"value_usd": f.value_usd, "qty": f.qty},
                subject={"reporter": f.reporter, "partner": f.partner, "hs6": f.hs6, "year": f.year},
                region=f.reporter,
            )


def flow_from_record(rec: Record) -> FlowRow | None:
    if rec.attribute != ATTRIBUTE:
        return None
    s, v = rec.subject, rec.value
    try:
        return FlowRow(reporter=str(s["reporter"]), partner=str(s["partner"]), hs6=str(s["hs6"]),
                       year=int(s["year"]), value_usd=int(v["value_usd"]),
                       qty=None if v.get("qty") is None else float(v["qty"]))
    except (KeyError, TypeError, ValueError):
        return None
