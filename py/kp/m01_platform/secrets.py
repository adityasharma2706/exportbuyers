"""M01 secrets: read only from AWS Secrets Manager at boot.

In ``local``/``test`` only, a missing key falls back to the process environment.
"""
from __future__ import annotations

import json
import os
from types import MappingProxyType
from typing import Mapping

from .config import PlatformConfig, assert_india_region
from .errors import KpError

_secrets: Mapping[str, str] | None = None
_dev_fallback = False


def load_secrets(cfg: PlatformConfig) -> None:
    global _secrets, _dev_fallback
    _dev_fallback = cfg.app_env in ("local", "test")
    region = assert_india_region(cfg.region, "secrets manager region")
    try:
        import boto3  # imported lazily so tests without AWS deps still import the package

        client = boto3.client("secretsmanager", region_name=region)
        raw = client.get_secret_value(SecretId=cfg.secrets_id).get("SecretString")
        if not isinstance(raw, str) or not raw:
            raise KpError("INTERNAL", f"Secret {cfg.secrets_id} has no SecretString")
        parsed = json.loads(raw)
        if not isinstance(parsed, dict) or not all(isinstance(v, str) for v in parsed.values()):
            raise KpError("INTERNAL", f"Secret {cfg.secrets_id} must be a JSON object of strings")
        _secrets = MappingProxyType(dict(parsed))
    except Exception:
        if not _dev_fallback:
            raise
        _secrets = MappingProxyType({})


def set_secrets_for_testing(bundle: Mapping[str, str]) -> None:
    global _secrets, _dev_fallback
    _secrets = MappingProxyType(dict(bundle))
    _dev_fallback = True


def get_secret(name: str) -> str:
    if _secrets is not None and _secrets.get(name):
        return _secrets[name]
    if _dev_fallback and os.environ.get(name):
        return os.environ[name]
    if _secrets is None:
        raise KpError("INTERNAL", "Secrets have not been loaded; call load_secrets() at boot")
    raise KpError("INTERNAL", f"Secret {name} is not configured")
