"""M02 — 5-field cron expressions evaluated in UTC. Mirror of apps/web/src/modules/m02_queue/cron.ts.

Supports ``*``, ``*/n``, ``a``, ``a-b``, ``a-b/n``, ``a/n``, comma lists, month and weekday
names, and the @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly macros.
When both day-of-month and day-of-week are restricted a day matches if either matches.
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from kp.m01_platform import KpError

_MACROS = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
}
_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
_DOWS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]

# (name, min, max, names, name_offset)
_FIELDS: list[tuple[str, int, int, list[str] | None, int]] = [
    ("minute", 0, 59, None, 0),
    ("hour", 0, 23, None, 0),
    ("day-of-month", 1, 31, None, 0),
    ("month", 1, 12, _MONTHS, 1),
    ("day-of-week", 0, 7, _DOWS, 0),
]

_MINUTE = timedelta(minutes=1)


@dataclass(frozen=True)
class CronSpec:
    source: str
    minutes: frozenset[int]
    hours: frozenset[int]
    days_of_month: frozenset[int]
    months: frozenset[int]
    days_of_week: frozenset[int]  # 0 = Sunday
    dom_restricted: bool
    dow_restricted: bool


def _bad(expr: str, why: str) -> KpError:
    return KpError("VALIDATION", f'Invalid cron expression "{expr}": {why}', {"cron": expr})


def _value(raw: str, field: tuple[str, int, int, list[str] | None, int], expr: str) -> int:
    name, lo, hi, names, offset = field
    if names and raw.upper() in names:
        return names.index(raw.upper()) + offset
    if not re.fullmatch(r"\d+", raw):
        raise _bad(expr, f'"{raw}" is not a valid {name} value')
    n = int(raw)
    if n < lo or n > hi:
        raise _bad(expr, f"{name} value {n} is outside {lo}-{hi}")
    return n


def _field(text: str, field: tuple[str, int, int, list[str] | None, int], expr: str) -> tuple[set[int], bool]:
    name, fmin, fmax, _, _ = field
    values: set[int] = set()
    restricted = True
    for part in text.split(","):
        if not part:
            raise _bad(expr, f"empty list item in {name}")
        pieces = part.split("/")
        if len(pieces) > 2:
            raise _bad(expr, f"malformed step in {name}")
        range_part = pieces[0]
        step = 1
        if len(pieces) == 2:
            if not re.fullmatch(r"\d+", pieces[1]) or int(pieces[1]) < 1:
                raise _bad(expr, f'step "{pieces[1]}" in {name} must be a positive integer')
            step = int(pieces[1])
        if range_part == "*":
            lo, hi = fmin, fmax
            if len(pieces) == 1 and text == "*":
                restricted = False
        elif "-" in range_part:
            ab = range_part.split("-")
            if len(ab) != 2:
                raise _bad(expr, f"malformed range in {name}")
            lo, hi = _value(ab[0], field, expr), _value(ab[1], field, expr)
            if lo > hi:
                raise _bad(expr, f"range {range_part} in {name} is reversed")
        else:
            lo = _value(range_part, field, expr)
            hi = fmax if len(pieces) == 2 else lo
        values.update(range(lo, hi + 1, step))
    return values, restricted


def parse_cron(expr: str) -> CronSpec:
    if not isinstance(expr, str):
        raise _bad(str(expr), "not a string")
    trimmed = expr.strip()
    expanded = _MACROS.get(trimmed.lower(), trimmed)
    parts = expanded.split()
    if len(parts) != 5:
        raise _bad(expr, f"expected 5 fields, got {len(parts)}")
    parsed = [_field(p, _FIELDS[i], expr) for i, p in enumerate(parts)]
    dow = frozenset(0 if d == 7 else d for d in parsed[4][0])
    return CronSpec(
        source=trimmed,
        minutes=frozenset(parsed[0][0]),
        hours=frozenset(parsed[1][0]),
        days_of_month=frozenset(parsed[2][0]),
        months=frozenset(parsed[3][0]),
        days_of_week=dow,
        dom_restricted=parsed[2][1],
        dow_restricted=parsed[4][1],
    )


def _utc(d: datetime) -> datetime:
    if d.tzinfo is None:
        return d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def _cron_dow(d: datetime) -> int:
    return (d.weekday() + 1) % 7  # Python: Monday=0 → cron: Sunday=0


def _day_matches(spec: CronSpec, d: datetime) -> bool:
    dom_ok = d.day in spec.days_of_month
    dow_ok = _cron_dow(d) in spec.days_of_week
    if spec.dom_restricted and spec.dow_restricted:
        return dom_ok or dow_ok
    return dom_ok and dow_ok


def cron_matches(spec: CronSpec, d: datetime) -> bool:
    d = _utc(d)
    return d.month in spec.months and _day_matches(spec, d) and d.hour in spec.hours and d.minute in spec.minutes


def previous_fire(spec: CronSpec, at_or_before: datetime, after: datetime) -> datetime | None:
    """Latest fire time t with after < t <= at_or_before, or None."""
    t = _utc(at_or_before).replace(second=0, microsecond=0)
    after = _utc(after)
    guard = 0
    while t > after and guard < 2_000_000:
        guard += 1
        if t.month not in spec.months:
            t = t.replace(day=1, hour=0, minute=0) - _MINUTE
            continue
        if not _day_matches(spec, t):
            t = t.replace(hour=0, minute=0) - _MINUTE
            continue
        if t.hour not in spec.hours:
            t = t.replace(minute=0) - _MINUTE
            continue
        if t.minute not in spec.minutes:
            t = t - _MINUTE
            continue
        return t
    return None


def next_fire(spec: CronSpec, after: datetime) -> datetime | None:
    """Earliest fire time strictly after ``after`` (searches ~5 years ahead), or None."""
    t = _utc(after).replace(second=0, microsecond=0) + _MINUTE
    limit = _utc(after) + timedelta(days=5 * 366)
    while t <= limit:
        if t.month not in spec.months:
            last_day = calendar.monthrange(t.year, t.month)[1]
            t = t.replace(day=last_day, hour=0, minute=0) + timedelta(days=1)
            continue
        if not _day_matches(spec, t):
            t = t.replace(hour=0, minute=0) + timedelta(days=1)
            continue
        if t.hour not in spec.hours:
            t = t.replace(minute=0) + timedelta(hours=1)
            continue
        if t.minute not in spec.minutes:
            t = t + _MINUTE
            continue
        return t
    return None
