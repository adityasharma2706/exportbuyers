"""M21 configuration: ``config/customs_us.yaml`` with environment overrides."""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import yaml

from kp.m01_platform import KpError
from kp.m02_queue import parse_cron

from .models import DEFAULT_CRON, source_id_for


def config_dir() -> Path:
    """<repo>/config (py/kp/m21_customs_us/config.py → parents[3] is the repo root)."""
    return Path(__file__).resolve().parents[3] / "config"


@dataclass(frozen=True)
class CustomsUsConfig:
    vendor: str | None = None
    drop_uri: str | None = None
    lake_uri: str | None = None
    cron: str = DEFAULT_CRON
    cost_micros_per_file: int = 0
    columns: Mapping[str, tuple[str, ...]] = field(default_factory=dict)

    @property
    def source_id(self) -> str | None:
        return source_id_for(self.vendor) if self.vendor else None


def parse_config(data: Mapping[str, Any] | None, env: Mapping[str, str] | None = None) -> CustomsUsConfig:
    d = dict(data or {})
    e = os.environ if env is None else env
    vendor = e.get("CUSTOMS_US_VENDOR") or d.get("vendor")
    if vendor is not None:
        vendor = str(vendor).strip().lower() or None
        if vendor:
            source_id_for(vendor)
    drop_uri = e.get("CUSTOMS_US_DROP_URI") or d.get("drop_uri")
    lake_uri = e.get("CUSTOMS_US_LAKE_URI") or d.get("lake_uri")
    cron = str(d.get("cron") or DEFAULT_CRON)
    try:
        parse_cron(cron)
    except KpError as ex:
        raise KpError("INTERNAL", f"config/customs_us.yaml: invalid cron {cron!r}") from ex
    cost = d.get("cost_micros_per_file", 0)
    if not isinstance(cost, int) or isinstance(cost, bool) or cost < 0:
        raise KpError("INTERNAL", "config/customs_us.yaml: cost_micros_per_file must be a non-negative integer")
    cols_raw = d.get("columns") or {}
    if not isinstance(cols_raw, Mapping):
        raise KpError("INTERNAL", "config/customs_us.yaml: columns must be a mapping")
    columns: dict[str, tuple[str, ...]] = {}
    for k, v in cols_raw.items():
        names = [v] if isinstance(v, str) else list(v or [])
        if not all(isinstance(n, str) and n.strip() for n in names):
            raise KpError("INTERNAL", f"config/customs_us.yaml: columns.{k} must be a list of names")
        columns[str(k)] = tuple(n.strip() for n in names)
    return CustomsUsConfig(vendor=vendor, drop_uri=str(drop_uri).rstrip("/") if drop_uri else None,
                           lake_uri=str(lake_uri).rstrip("/") if lake_uri else None, cron=cron,
                           cost_micros_per_file=cost, columns=columns)


_cached: CustomsUsConfig | None = None
_override: CustomsUsConfig | None = None
_lock = threading.Lock()


def get_customs_config() -> CustomsUsConfig:
    global _cached
    if _override is not None:
        return _override
    with _lock:
        if _cached is None:
            path = config_dir() / "customs_us.yaml"
            try:
                with path.open("r", encoding="utf-8") as fh:
                    data = yaml.safe_load(fh)
            except FileNotFoundError:
                data = {}
            except yaml.YAMLError as ex:
                raise KpError("INTERNAL", f"M21 config file is not valid YAML: {path}") from ex
            if data is not None and not isinstance(data, Mapping):
                raise KpError("INTERNAL", f"M21 config file must be a mapping: {path}")
            _cached = parse_config(data)
        return _cached


def set_customs_config_for_testing(cfg: CustomsUsConfig | None) -> None:
    global _override, _cached
    _override = cfg
    _cached = None
