"""M21 analytics lake: BOL rows as Parquet at ``<lake>/week=YYYY-WW/part-NNNN.parquet`` and the
12-month aggregation in DuckDB SQL (plain ANSI-ish SQL, so it ports to Athena unchanged apart from
``qualify`` / ``mode``).

The lake root is ``CUSTOMS_US_LAKE_URI`` (or ``lake_uri`` in ``config/customs_us.yaml``), defaulting
to ``s3://exportbuyers-<env>-analytics/customs_us``; a local path works for dev and tests.
"""
from __future__ import annotations

import os
import posixpath
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Iterable, Sequence
from urllib.parse import urlsplit

import pyarrow as pa
import pyarrow.fs as pafs
import pyarrow.parquet as pq

from kp.m01_platform import KpError, assert_india_region, get_config, get_logger

from .models import (
    HS_CONFIDENCE_MIN,
    LAST_SEEN_WINDOW_DAYS,
    TOP_SUPPLIERS,
    WINDOW_DAYS,
    BolRow,
    ConsigneeGroup,
    HeadingAggregate,
    IsoWeek,
    Supplier,
)

_log = get_logger("kp.m21_customs_us.lake")

PARQUET_SCHEMA = pa.schema([
    pa.field("bol_id", pa.string(), nullable=False),
    pa.field("arrival_date", pa.date32(), nullable=False),
    pa.field("consignee_name", pa.string(), nullable=False),
    pa.field("consignee_addr", pa.string()),
    pa.field("shipper_name", pa.string()),
    pa.field("shipper_country", pa.string()),
    pa.field("hs_code", pa.string()),
    pa.field("description", pa.string()),
    pa.field("weight_kg", pa.float64()),
    pa.field("teu", pa.float64()),
    pa.field("hs_heading", pa.string()),
    pa.field("hs_confidence", pa.float64()),
    pa.field("hs_method", pa.string()),
    pa.field("consignee_key", pa.string(), nullable=False),
    pa.field("shipper_key", pa.string(), nullable=False),
    pa.field("batch_week", pa.string(), nullable=False),
])

# Deliveries can carry arrivals from before the delivery week; read this many extra weeks back.
LATE_DELIVERY_WEEKS = 8


def default_lake_uri() -> str:
    explicit = os.environ.get("CUSTOMS_US_LAKE_URI")
    if explicit:
        return explicit.rstrip("/")
    return f"s3://exportbuyers-{get_config().app_env}-analytics/customs_us"


class ParquetLake:
    def __init__(self, uri: str | None = None, filesystem: pafs.FileSystem | None = None) -> None:
        self.uri = (uri or default_lake_uri()).rstrip("/")
        parts = urlsplit(self.uri)
        if filesystem is not None:
            self.fs = filesystem
            self.root = parts.netloc + parts.path if parts.scheme == "s3" else (parts.path or self.uri)
        elif parts.scheme == "s3":
            self.fs = pafs.S3FileSystem(region=assert_india_region(get_config().region, "analytics bucket"))
            self.root = (parts.netloc + parts.path).rstrip("/")
        elif parts.scheme in ("", "file"):
            self.fs = pafs.LocalFileSystem()
            self.root = os.path.abspath(parts.path if parts.scheme == "file" else self.uri)
        else:
            raise KpError("VALIDATION", "lake uri must be s3:// or a local path", {"uri": self.uri})

    def week_dir(self, week: IsoWeek) -> str:
        return posixpath.join(self.root, f"week={week}")

    def clear_week(self, week: IsoWeek) -> None:
        """Removes a week's parts so a re-run replaces, rather than duplicates, the week."""
        d = self.week_dir(week)
        info = self.fs.get_file_info(d)
        if info.type == pafs.FileType.Directory:
            self.fs.delete_dir_contents(d, missing_dir_ok=True)

    def write_part(self, week: IsoWeek, part: int, rows: Sequence[BolRow]) -> str:
        if not rows:
            raise KpError("INTERNAL", "write_part called with no rows")
        d = self.week_dir(week)
        self.fs.create_dir(d, recursive=True)
        path = posixpath.join(d, f"part-{part:04d}.parquet")
        cols: dict[str, list[Any]] = {f.name: [] for f in PARQUET_SCHEMA}
        for r in rows:
            rec = r.as_record()
            for name in cols:
                cols[name].append(rec[name])
        table = pa.Table.from_pydict(cols, schema=PARQUET_SCHEMA)
        pq.write_table(table, path, filesystem=self.fs, compression="zstd")
        return path

    def files_for_weeks(self, weeks: Iterable[IsoWeek]) -> list[str]:
        wanted = {f"week={w}" for w in weeks}
        base = self.fs.get_file_info(self.root)
        if base.type != pafs.FileType.Directory:
            return []
        out: list[str] = []
        for info in self.fs.get_file_info(pafs.FileSelector(self.root, recursive=True)):
            if info.type != pafs.FileType.File or not info.path.endswith(".parquet"):
                continue
            parent = posixpath.basename(posixpath.dirname(info.path))
            if parent in wanted:
                out.append(info.path)
        return sorted(out)


def weeks_between(first: date, last: date) -> list[IsoWeek]:
    out: list[IsoWeek] = []
    d = first - timedelta(days=first.weekday())
    while d <= last:
        out.append(IsoWeek.of(d))
        d += timedelta(days=7)
    return out


@dataclass(frozen=True)
class Window:
    as_of: date          # inclusive end (the batch week's Sunday)
    start_12m: date      # exclusive
    start_24m: date      # exclusive

    @classmethod
    def for_week(cls, week: IsoWeek) -> Window:
        end = week.end
        return cls(as_of=end, start_12m=end - timedelta(days=WINDOW_DAYS),
                   start_24m=end - timedelta(days=LAST_SEEN_WINDOW_DAYS))

    def weeks_to_read(self) -> list[IsoWeek]:
        return weeks_between(self.start_24m, self.as_of + timedelta(days=7 * LATE_DELIVERY_WEEKS))


def _lit(d: date) -> str:
    return f"DATE '{d.isoformat()}'"


def latest_sql(w: Window, min_conf: float = HS_CONFIDENCE_MIN) -> str:
    """Rows in the 24-month window with a usable heading; a BOL re-delivered in a later batch
    replaces its earlier delivery."""
    return f"""
        create or replace temp table latest as
        select bol_id, arrival_date, consignee_key, consignee_name, consignee_addr, shipper_key,
               shipper_name, shipper_country, hs_heading, hs_confidence, weight_kg, teu, batch_week
        from bol
        where arrival_date > {_lit(w.start_24m)} and arrival_date <= {_lit(w.as_of)}
          and consignee_key <> '' and hs_heading is not null and hs_confidence >= {float(min_conf)!r}
        qualify batch_week = max(batch_week) over (partition by bol_id)
    """


def heading_sql(w: Window) -> str:
    s = _lit(w.start_12m)
    return f"""
        select consignee_key, hs_heading,
               count(distinct bol_id) filter (where arrival_date > {s})                 as shipments_12m,
               coalesce(sum(weight_kg) filter (where arrival_date > {s}), 0)::double   as volume_kg_12m,
               coalesce(sum(teu) filter (where arrival_date > {s}), 0)::double         as teu_12m,
               max(arrival_date)                                                       as last_seen,
               count(*)                                                                as row_count,
               avg(hs_confidence)                                                      as mean_conf
        from latest
        group by consignee_key, hs_heading
        order by consignee_key, hs_heading
    """


def origins_sql(w: Window) -> str:
    return f"""
        select consignee_key, hs_heading, shipper_country, count(distinct bol_id) as n
        from latest
        where arrival_date > {_lit(w.start_12m)} and shipper_country is not null
        group by consignee_key, hs_heading, shipper_country
    """


def suppliers_sql(w: Window, top: int = TOP_SUPPLIERS) -> str:
    return f"""
        select consignee_key, hs_heading, shipper_key, name, country, n from (
            select consignee_key, hs_heading, shipper_key,
                   mode(shipper_name)     as name,
                   mode(shipper_country)  as country,
                   count(distinct bol_id) as n,
                   row_number() over (partition by consignee_key, hs_heading
                                      order by count(distinct bol_id) desc, shipper_key) as rk
            from latest
            where arrival_date > {_lit(w.start_12m)} and shipper_key <> ''
            group by consignee_key, hs_heading, shipper_key
        ) where rk <= {int(top)}
        order by consignee_key, hs_heading, n desc, shipper_key
    """


IDENTITY_SQL = """
    select consignee_key, mode(consignee_name) as name, mode(consignee_addr) as addr
    from latest group by consignee_key
"""


def aggregate(lake: ParquetLake, week: IsoWeek, *, min_conf: float = HS_CONFIDENCE_MIN) -> list[ConsigneeGroup]:
    """Per consignee × heading aggregates as of the end of ``week`` (LLD M21)."""
    import duckdb
    import pyarrow.dataset as ds

    w = Window.for_week(week)
    files = lake.files_for_weeks(w.weeks_to_read())
    if not files:
        _log.warning("no Parquet parts in the aggregation window", extra={"week": str(week)})
        return []
    dataset = ds.dataset(files, schema=PARQUET_SCHEMA, format="parquet", filesystem=lake.fs)
    con = duckdb.connect(database=":memory:")
    try:
        con.register("bol", dataset)
        con.execute(latest_sql(w, min_conf))
        heads = con.execute(heading_sql(w)).fetchall()
        origins = con.execute(origins_sql(w)).fetchall()
        sups = con.execute(suppliers_sql(w)).fetchall()
        idents = con.execute(IDENTITY_SQL).fetchall()
    except duckdb.Error as e:
        raise KpError("INTERNAL", "customs aggregation query failed", {"week": str(week), "err": str(e)[:500]}) from e
    finally:
        con.close()

    origin_map: dict[tuple[str, str], dict[str, int]] = {}
    for ck, h, cc, n in origins:
        origin_map.setdefault((ck, h), {})[str(cc)] = int(n)
    sup_map: dict[tuple[str, str], list[Supplier]] = {}
    for ck, h, _sk, name, country, n in sups:
        if name:
            sup_map.setdefault((ck, h), []).append(Supplier(name=str(name), country=country, shipments=int(n)))
    groups: dict[str, ConsigneeGroup] = {
        str(ck): ConsigneeGroup(consignee_key=str(ck), name=str(name), address=addr) for ck, name, addr in idents
    }
    for ck, h, ship, kg, teu, last_seen, row_count, mean_conf in heads:
        g = groups.get(ck)
        if g is None:
            continue
        g.headings.append(HeadingAggregate(
            hs_heading=str(h), shipments_12m=int(ship or 0), volume_kg_12m=float(kg or 0.0),
            teu_12m=float(teu or 0.0), origins=origin_map.get((ck, h), {}),
            top_suppliers=sup_map.get((ck, h), []), last_seen=last_seen, row_count=int(row_count),
            mean_hs_confidence=float(mean_conf or 0.0),
        ))
    return [g for g in groups.values() if g.headings]
