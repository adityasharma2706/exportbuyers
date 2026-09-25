"""M01 config and India-region guard (REQ-061/REQ-062 hosting, REQ-057 latency)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

from .errors import KpError

INDIA_REGIONS: tuple[str, ...] = ("ap-south-1", "ap-south-2")
PRIMARY_REGION = "ap-south-1"
APP_ENVS = ("local", "test", "staging", "production")


def is_india_region(region: str) -> bool:
    return region.strip().lower() in INDIA_REGIONS


def assert_india_region(region: str | None, what: str) -> str:
    if not region or not is_india_region(region):
        raise KpError(
            "INTERNAL",
            f"{what} must be hosted in an India region ({', '.join(INDIA_REGIONS)}); got {region!r}",
            {"what": what, "region": region},
        )
    return region.strip().lower()


def _int(env: Mapping[str, str], key: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        n = int(raw)
    except ValueError as e:
        raise KpError("VALIDATION", f"Config {key} must be an integer", {"key": key}) from e
    if not lo <= n <= hi:
        raise KpError("VALIDATION", f"Config {key} must be in [{lo}, {hi}]", {"key": key})
    return n


@dataclass(frozen=True)
class PlatformConfig:
    app_env: str
    service_name: str
    region: str
    secrets_id: str
    log_level: str
    cost_flush_interval_s: float
    cost_max_buffered: int


def load_config(env: Mapping[str, str] | None = None) -> PlatformConfig:
    e: Mapping[str, str] = os.environ if env is None else env
    app_env = e.get("APP_ENV", "local")
    if app_env not in APP_ENVS:
        raise KpError("VALIDATION", f"APP_ENV must be one of {APP_ENVS}", {"value": app_env})
    region = assert_india_region(e.get("AWS_REGION", PRIMARY_REGION), "AWS_REGION")
    secrets_id = e.get("SECRETS_ID") or ""
    if not secrets_id:
        if app_env in ("staging", "production"):
            raise KpError("VALIDATION", f"Config SECRETS_ID is required in {app_env}", {"key": "SECRETS_ID"})
        secrets_id = f"exportbuyers/{app_env}/kp"
    return PlatformConfig(
        app_env=app_env,
        service_name=e.get("SERVICE_NAME", "kp"),
        region=region,
        secrets_id=secrets_id,
        log_level=e.get("LOG_LEVEL", "INFO" if app_env == "production" else "DEBUG").upper(),
        cost_flush_interval_s=_int(e, "COST_FLUSH_INTERVAL_MS", 5000, 100, 600_000) / 1000.0,
        cost_max_buffered=_int(e, "COST_MAX_BUFFERED_EVENTS", 10_000, 10, 1_000_000),
    )


_current: PlatformConfig | None = None


def get_config() -> PlatformConfig:
    global _current
    if _current is None:
        _current = load_config()
    return _current
