"""M03 tier configuration (Python mirror of apps/web/src/modules/m03_llm/config.ts).

llm.tiers.<tier> = {provider, model, maxTokens, fallback?}, loaded from the ``LLM_CONFIG``
environment variable (JSON, partial overrides merged per tier over the defaults).
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, replace
from typing import Any, Literal

from kp.m01_platform import KpError

Tier = Literal["classify", "draft"]
AnyTier = Literal["classify", "draft", "embed"]
TIERS: tuple[str, ...] = ("classify", "draft", "embed")
TEXT_TIERS: tuple[str, ...] = ("classify", "draft")

_PROVIDER_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")
_INR_MICROS_PER_USD = 84_000_000  # [tunable]


@dataclass(frozen=True)
class ModelTarget:
    provider: str
    model: str
    max_tokens: int
    input_micros_inr_per_mtok: int
    output_micros_inr_per_mtok: int
    base_url: str | None = None


@dataclass(frozen=True)
class TierConfig:
    target: ModelTarget
    timeout_s: float
    default_temperature: float
    fallback: ModelTarget | None = None
    dimensions: int | None = None


@dataclass(frozen=True)
class LlmConfig:
    tiers: dict[str, TierConfig]
    cache_ttl_s: int = 30 * 24 * 3600
    embed_batch_size: int = 128
    log_max_chars: int = 8000


def _defaults() -> LlmConfig:
    return LlmConfig(
        tiers={
            "classify": TierConfig(
                target=ModelTarget("anthropic", "claude-haiku-4-5", 1024, 1 * _INR_MICROS_PER_USD, 5 * _INR_MICROS_PER_USD),
                timeout_s=20.0,
                default_temperature=0.0,
            ),
            "draft": TierConfig(
                target=ModelTarget("anthropic", "claude-sonnet-4-5", 4096, 3 * _INR_MICROS_PER_USD, 15 * _INR_MICROS_PER_USD),
                timeout_s=60.0,
                default_temperature=0.7,
            ),
            "embed": TierConfig(
                target=ModelTarget("voyage", "voyage-3", 0, round(0.06 * _INR_MICROS_PER_USD), 0),
                timeout_s=20.0,
                default_temperature=0.0,
                dimensions=1024,
            ),
        }
    )


_TARGET_KEYS = {
    "provider": "provider",
    "model": "model",
    "maxTokens": "max_tokens",
    "baseUrl": "base_url",
    "inputMicrosInrPerMTok": "input_micros_inr_per_mtok",
    "outputMicrosInrPerMTok": "output_micros_inr_per_mtok",
}


def _merge_target(base: ModelTarget | None, patch: dict[str, Any]) -> ModelTarget:
    kwargs: dict[str, Any] = dict(base.__dict__) if base else {
        "provider": "", "model": "", "max_tokens": 0,
        "input_micros_inr_per_mtok": 0, "output_micros_inr_per_mtok": 0, "base_url": None,
    }
    for k, v in patch.items():
        if k in _TARGET_KEYS:
            kwargs[_TARGET_KEYS[k]] = v
    return ModelTarget(**kwargs)


def _validate_target(t: ModelTarget, what: str, is_embed: bool) -> None:
    if not isinstance(t.provider, str) or not _PROVIDER_RE.match(t.provider):
        raise KpError("VALIDATION", f"LLM config: {what}.provider is invalid")
    if not isinstance(t.model, str) or not t.model:
        raise KpError("VALIDATION", f"LLM config: {what}.model is required")
    for name in ("max_tokens", "input_micros_inr_per_mtok", "output_micros_inr_per_mtok"):
        v = getattr(t, name)
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise KpError("VALIDATION", f"LLM config: {what}.{name} must be a non-negative int")
    if not is_embed and t.max_tokens < 1:
        raise KpError("VALIDATION", f"LLM config: {what}.max_tokens must be >= 1")
    if t.base_url is not None and not re.match(r"^https?://", t.base_url):
        raise KpError("VALIDATION", f"LLM config: {what}.base_url must be http(s)")


def validate_llm_config(cfg: LlmConfig) -> LlmConfig:
    for tier in TIERS:
        tc = cfg.tiers.get(tier)
        if tc is None:
            raise KpError("VALIDATION", f"LLM config: tier {tier!r} is missing")
        is_embed = tier == "embed"
        _validate_target(tc.target, f"tiers.{tier}", is_embed)
        if tc.fallback is not None:
            _validate_target(tc.fallback, f"tiers.{tier}.fallback", is_embed)
        if tc.timeout_s < 0.1:
            raise KpError("VALIDATION", f"LLM config: tiers.{tier} timeout too small")
        if not 0 <= tc.default_temperature <= 2:
            raise KpError("VALIDATION", f"LLM config: tiers.{tier}.defaultTemperature must be in [0, 2]")
        if is_embed and (tc.dimensions is None or tc.dimensions < 1):
            raise KpError("VALIDATION", "LLM config: tiers.embed.dimensions must be >= 1")
    if cfg.cache_ttl_s < 1 or not 1 <= cfg.embed_batch_size <= 2048:
        raise KpError("VALIDATION", "LLM config: cacheTtlSec / embedBatchSize out of range")
    return cfg


def build_llm_config(override: Any) -> LlmConfig:
    """Merges the parsed LLM_CONFIG JSON (same shape as the TS side) over the defaults."""
    cfg = _defaults()
    if override is None:
        return validate_llm_config(cfg)
    if not isinstance(override, dict):
        raise KpError("VALIDATION", "LLM_CONFIG must be a JSON object")
    tiers = dict(cfg.tiers)
    for name, patch in (override.get("tiers") or {}).items():
        if name not in TIERS:
            raise KpError("VALIDATION", f"LLM_CONFIG.tiers: unknown tier {name!r}")
        if not isinstance(patch, dict):
            raise KpError("VALIDATION", f"LLM_CONFIG.tiers.{name} must be an object")
        cur = tiers[name]
        new = replace(cur, target=_merge_target(cur.target, patch))
        if "timeoutMs" in patch:
            new = replace(new, timeout_s=float(patch["timeoutMs"]) / 1000.0)
        if "defaultTemperature" in patch:
            new = replace(new, default_temperature=float(patch["defaultTemperature"]))
        if "dimensions" in patch:
            new = replace(new, dimensions=int(patch["dimensions"]))
        if "fallback" in patch:
            fb = patch["fallback"]
            new = replace(new, fallback=None if fb is None else _merge_target(cur.fallback, fb))
        tiers[name] = new
    cfg = LlmConfig(
        tiers=tiers,
        cache_ttl_s=int(override.get("cacheTtlSec", cfg.cache_ttl_s)),
        embed_batch_size=int(override.get("embedBatchSize", cfg.embed_batch_size)),
        log_max_chars=int(override.get("logMaxChars", cfg.log_max_chars)),
    )
    return validate_llm_config(cfg)


def load_llm_config(env: dict[str, str] | None = None) -> LlmConfig:
    raw = (env if env is not None else os.environ).get("LLM_CONFIG", "")
    if not raw.strip():
        return build_llm_config(None)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise KpError("VALIDATION", "LLM_CONFIG is not valid JSON") from e
    return build_llm_config(parsed)


_current: LlmConfig | None = None


def get_llm_config() -> LlmConfig:
    global _current
    if _current is None:
        _current = load_llm_config()
    return _current


def set_llm_config_for_testing(cfg: LlmConfig | None) -> None:
    global _current
    _current = validate_llm_config(cfg) if cfg is not None else None


def cost_micros_inr(target: ModelTarget, input_tokens: int, output_tokens: int) -> int:
    c = (input_tokens * target.input_micros_inr_per_mtok + output_tokens * target.output_micros_inr_per_mtok) / 1_000_000
    return max(0, round(c))


__all__ = [
    "AnyTier", "LlmConfig", "ModelTarget", "TEXT_TIERS", "TIERS", "Tier", "TierConfig", "build_llm_config",
    "cost_micros_inr", "get_llm_config", "load_llm_config", "set_llm_config_for_testing", "validate_llm_config",
]
