"""M21 ``CustomsUsConnector(source_id='customs.us.<vendor>')`` — an M08 connector over the vendor
interface ``fetch(week) -> files``.

``run(FetchRequest(params={'week': 'YYYY-WW'}))`` fetches the week's vendor files, lands each one
unchanged in raw storage (``s3://<raw>/customs.us.<vendor>/yyyy/mm/dd/<sha256>``; M08, idempotent
on sha256), and parses it into bill-of-lading rows. Each row travels to the run's sink as an
in-memory M08 ``Record`` (attribute ``customs.bol_row``) so it gets the register's licence and
region checks. **These records are never written to M09**: the M21 pipeline collects them into
Parquet and only the aggregates become assertions.
"""
from __future__ import annotations

from typing import Any, ClassVar, Iterator

from kp.m01_platform import KpError
from kp.m08_sources import Connector, FetchRequest, RawIndex, RawItem, RawRef, RawStore, Record, RecordSink

from .models import COUNTRY, RATE_CLASS, BolRow, IsoWeek, source_id_for
from .vendor import ColumnMap, CustomsUsVendor, ParseStats, parse_vendor_file

BOL_ROW_ATTRIBUTE = "customs.bol_row"   # in-memory only; not an M09 attribute


class CustomsUsConnector(Connector):
    """Use ``CustomsUsConnector.for_vendor(vendor_impl)``; the subclass carries the register id."""

    source_id: ClassVar[str]
    rate_class: ClassVar[str] = RATE_CLASS

    def __init__(self, vendor: CustomsUsVendor, *, columns: ColumnMap | None = None,
                 sink: RecordSink | None = None, store: RawStore | None = None, index: RawIndex | None = None) -> None:
        expected = source_id_for(vendor.name)
        if getattr(type(self), "source_id", None) != expected:
            raise KpError("INTERNAL", "Construct the connector with CustomsUsConnector.for_vendor(vendor)",
                          {"vendor": vendor.name})
        super().__init__(sink=sink, store=store, index=index)
        self.vendor_impl = vendor
        self.columns = columns or ColumnMap()
        self.parse_stats = ParseStats()

    _classes: ClassVar[dict[str, type[CustomsUsConnector]]] = {}

    @classmethod
    def for_vendor(cls, vendor: CustomsUsVendor, **kwargs: Any) -> CustomsUsConnector:
        sid = source_id_for(vendor.name)
        klass = CustomsUsConnector._classes.get(sid)
        if klass is None:
            klass = type(f"CustomsUsConnector_{vendor.name.replace('-', '_')}", (CustomsUsConnector,),
                         {"source_id": sid, "vendor": sid})
            CustomsUsConnector._classes[sid] = klass
        return klass(vendor, **kwargs)

    @staticmethod
    def week_of(req: FetchRequest) -> IsoWeek:
        w = req.params.get("week")
        if not isinstance(w, str):
            raise KpError("VALIDATION", "FetchRequest.params.week (YYYY-WW) is required")
        return IsoWeek.parse(w)

    def fetch(self, req: FetchRequest) -> Iterator[RawItem]:
        week = self.week_of(req)
        for f in self.vendor_impl.fetch(week):
            yield RawItem(body=f.body, content_type=f.content_type, url=f.url, fetched_at=f.fetched_at,
                          cost_micros_inr=f.cost_micros_inr,
                          meta={"file_name": f.name, "week": str(week)})

    def parse(self, ref: RawRef) -> Iterator[Record]:
        body = self.body_of(ref)
        week = str(ref.meta.get("week", ""))
        file_name = str(ref.meta.get("file_name", ""))
        for i, row in enumerate(parse_vendor_file(body, ref.content_type, self.columns, self.parse_stats)):
            yield self.record(
                ref,
                attribute=BOL_ROW_ATTRIBUTE,
                value=row.as_value(),
                subject={"name": row.consignee_name, "country": COUNTRY},
                region=COUNTRY,
                extra_ref={"batch_week": week, "file_name": file_name, "row": i},
            )


def bol_row_of(rec: Record) -> BolRow | None:
    if rec.attribute != BOL_ROW_ATTRIBUTE or not isinstance(rec.value, dict):
        return None
    return BolRow.from_value(rec.value)
