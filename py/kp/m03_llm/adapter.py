"""M03 LLM adapter (IF-03a, Python mirror of adapter.ts).

complete(req) -> LlmResult; stream(req) -> LlmStream (iterate deltas, then .final()); embed(texts).
Same rules as TS: tiered models, Redis cache (30 d) for cacheable requests, one schema-repair
retry then LLM_BAD_OUTPUT, PII-aware logging, record_cost per provider call, fallback on
timeout/5xx then UPSTREAM_UNAVAILABLE, and a regex PII guard for pii_free requests.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Iterator, Literal

from kp.m01_platform import KpError, get_logger, get_secret, record_cost, span

from .config import TEXT_TIERS, ModelTarget, TierConfig, cost_micros_inr, get_llm_config
from .guard import assert_no_pii, parse_and_validate, sha256_hex, stable_json
from .providers import ProviderCall, ProviderCompletion, ProviderHttpError, ProviderTimeout, get_llm_provider

_log = get_logger("kp.m03_llm")
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")
LLM_BAD_OUTPUT = "LLM_BAD_OUTPUT"
CACHE_PREFIX = "llm:cache:v1:"


@dataclass
class LlmRequest:
    tier: Literal["classify", "draft"]
    purpose: str
    system: str
    messages: list[dict[str, str]]
    pii_free: bool
    json_schema: dict[str, Any] | None = None
    temperature: float | None = None
    cacheable: bool = False
    account_id: str | None = None
    correlation_id: str | None = None
    job_type: str | None = None
    timeout_s: float | None = None


@dataclass
class LlmResult:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    cached: bool
    json: Any = None


class LlmBadOutputError(KpError):
    """Output failed schema validation twice. INTERNAL for APIs; retryable inside jobs."""

    llm_code = LLM_BAD_OUTPUT
    retryable = True

    def __init__(self, purpose: str, validation_error: str) -> None:
        super().__init__("INTERNAL", f"{LLM_BAD_OUTPUT}: model output failed schema validation",
                         {"llmCode": LLM_BAD_OUTPUT, "purpose": purpose, "validationError": validation_error[:500]})


# --------------------------------------------------------------------------------------
# cache
# --------------------------------------------------------------------------------------

_cache_override: Any = None
_cache_disabled = False
_redis: Any = None


def set_llm_cache_client_for_testing(client: Any, disabled: bool = False) -> None:
    """Supply an object with get/set(key, value, ex=)/delete, or disabled=True to turn caching off."""
    global _cache_override, _cache_disabled
    _cache_override, _cache_disabled = client, disabled


def _cache_client() -> Any:
    global _redis
    if _cache_disabled:
        return None
    if _cache_override is not None:
        return _cache_override
    if _redis is None:
        try:
            import redis

            _redis = redis.Redis.from_url(get_secret("REDIS_URL"), decode_responses=True)
        except Exception:  # noqa: BLE001 - cache is optional
            return None
    return _redis


def llm_cache_key(tier: str, model: str, system: str, messages: list[dict[str, str]],
                  json_schema: dict[str, Any] | None, temperature: float) -> str:
    # Must match the TS key: temperature rendered like JS String(number).
    temp = str(int(temperature)) if float(temperature).is_integer() else repr(float(temperature))
    parts = [tier, model, system,
             stable_json([{"content": m["content"], "role": m["role"]} for m in messages]),
             "" if json_schema is None else stable_json(json_schema), temp]
    return CACHE_PREFIX + sha256_hex("|".join(parts))


def _cache_get(key: str) -> LlmResult | None:
    c = _cache_client()
    if c is None:
        return None
    try:
        raw = c.get(key)
        if raw is None:
            return None
        e = json.loads(raw)
        return LlmResult(text=e["text"], model=e["model"], input_tokens=int(e["inputTokens"]),
                         output_tokens=int(e["outputTokens"]), cached=True, json=e.get("json"))
    except Exception:  # noqa: BLE001
        _log.warning("llm cache read failed; calling provider")
        return None


def _cache_put(key: str, r: LlmResult, ttl_s: int) -> None:
    c = _cache_client()
    if c is None:
        return
    entry: dict[str, Any] = {"text": r.text, "model": r.model, "inputTokens": r.input_tokens, "outputTokens": r.output_tokens}
    if r.json is not None:
        entry["json"] = r.json
    try:
        c.set(key, json.dumps(entry), ex=ttl_s)
    except Exception:  # noqa: BLE001
        _log.warning("llm cache write failed")


# --------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------


def cost_op(purpose: str) -> str:
    s = re.sub(r"[^a-z0-9_.:-]", "_", purpose.lower())
    if not re.match(r"^[a-z0-9]", s):
        s = "p" + s
    s = s[:64]
    return s if _NAME_RE.match(s) else "llm"


def _validate(req: LlmRequest) -> None:
    if req.tier not in TEXT_TIERS:
        raise KpError("VALIDATION", f"Unknown LLM tier {req.tier!r}")
    if not isinstance(req.purpose, str) or not req.purpose.strip():
        raise KpError("VALIDATION", "LLM request purpose is required")
    if not req.messages:
        raise KpError("VALIDATION", "LLM request needs at least one message")
    for m in req.messages:
        if m.get("role") not in ("user", "assistant") or not isinstance(m.get("content"), str):
            raise KpError("VALIDATION", "LLM messages must be {role: user|assistant, content: str}")
    if req.messages[0]["role"] != "user":
        raise KpError("VALIDATION", 'The first LLM message must have role "user"')
    if not isinstance(req.pii_free, bool):
        raise KpError("VALIDATION", "LLM request must declare pii_free")
    if req.temperature is not None and not 0 <= req.temperature <= 2:
        raise KpError("VALIDATION", "LLM temperature must be in [0, 2]")
    if req.pii_free:
        assert_no_pii(req.purpose, [req.system, *(m["content"] for m in req.messages)])


def _estimate(s: str) -> int:
    return (len(s) + 3) // 4


def _fallback_eligible(e: BaseException) -> bool:
    return isinstance(e, ProviderTimeout) or (isinstance(e, ProviderHttpError) and (e.status == 0 or e.status >= 500))


def _map_error(e: BaseException, purpose: str, provider: str) -> KpError:
    if isinstance(e, KpError):
        return e
    if isinstance(e, ProviderTimeout) or (isinstance(e, ProviderHttpError) and (e.status in (0, 429) or e.status >= 500)):
        err = KpError("UPSTREAM_UNAVAILABLE", "The language model service is unavailable", {"purpose": purpose, "provider": provider})
    elif isinstance(e, ProviderHttpError):
        err = KpError("INTERNAL", f"LLM provider rejected the request (HTTP {e.status})", {"purpose": purpose, "provider": provider})
    else:
        err = KpError("INTERNAL", "LLM call failed", {"purpose": purpose, "provider": provider})
    err.__cause__ = e
    return err


def _record(purpose: str, target: ModelTarget, in_tok: int, out_tok: int, account_id: str | None,
            correlation_id: str | None, job_type: str | None) -> None:
    try:
        record_cost(vendor=target.provider, op=cost_op(purpose), units=in_tok + out_tok,
                    cost_micros_inr=cost_micros_inr(target, in_tok, out_tok), account_id=account_id,
                    correlation_id=correlation_id,
                    job_type=job_type if job_type and _NAME_RE.match(job_type) else None)
    except Exception:  # noqa: BLE001 - never lose paid output because of a cost bug
        _log.exception("llm cost recording failed", extra={"purpose": purpose, "vendor": target.provider})


def _trunc(s: str, n: int) -> str:
    return s if len(s) <= n else f"{s[:n]}…[+{len(s) - n} chars]"


def _log_call(req: LlmRequest, r: LlmResult, provider: str | None, latency_ms: int | None, **extra: Any) -> None:
    info: dict[str, Any] = {"purpose": req.purpose, "tier": req.tier, "model": r.model, "inputTokens": r.input_tokens,
                            "outputTokens": r.output_tokens, "cached": r.cached, **extra}
    if provider is not None:
        info["provider"], info["latencyMs"] = provider, latency_ms
    if req.pii_free:
        n = get_llm_config().log_max_chars
        info["prompt"] = {"system": _trunc(req.system, n),
                          "messages": [{"role": m["role"], "content": _trunc(m["content"], n)} for m in req.messages]}
        info["output"] = _trunc(r.text, n)
    else:
        info["promptHash"] = sha256_hex(stable_json({"system": req.system, "messages": req.messages}))
        info["outputHash"] = sha256_hex(r.text)
    _log.info("llm call", extra={"llm": info})


def _targets(tc: TierConfig) -> list[ModelTarget]:
    return [tc.target, tc.fallback] if tc.fallback else [tc.target]


def _call(target: ModelTarget, req: LlmRequest, messages: list[dict[str, str]], temperature: float,
          timeout_s: float) -> ProviderCall:
    return ProviderCall(model=target.model, max_tokens=target.max_tokens, system=req.system, messages=messages,
                        temperature=temperature, timeout_s=timeout_s, json_schema=req.json_schema,
                        base_url=target.base_url)


def _complete_with_fallback(req: LlmRequest, tc: TierConfig, messages: list[dict[str, str]], temperature: float,
                            timeout_s: float) -> tuple[ProviderCompletion, str, int]:
    targets = _targets(tc)
    last: BaseException | None = None
    provider_name = tc.target.provider
    for i, target in enumerate(targets):
        provider_name = target.provider
        started = time.monotonic()
        try:
            c = get_llm_provider(target.provider).complete(_call(target, req, messages, temperature, timeout_s))
            if time.monotonic() - started > timeout_s:
                raise ProviderTimeout(f"exceeded {timeout_s}s")
            c.input_tokens = c.input_tokens or _estimate(req.system + "".join(m["content"] for m in messages))
            c.output_tokens = c.output_tokens or _estimate(c.text)
            _record(req.purpose, target, c.input_tokens, c.output_tokens, req.account_id, req.correlation_id, req.job_type)
            return c, target.provider, int((time.monotonic() - started) * 1000)
        except Exception as e:  # noqa: BLE001
            last = e
            if not _fallback_eligible(e) or i == len(targets) - 1:
                break
            _log.warning("llm primary failed; retrying on fallback provider",
                         extra={"purpose": req.purpose, "provider": target.provider, "err": str(e)})
    assert last is not None
    raise _map_error(last, req.purpose, provider_name)


def _repair(messages: list[dict[str, str]], bad: str, error: str) -> list[dict[str, str]]:
    return [*messages, {"role": "assistant", "content": bad or "(empty response)"},
            {"role": "user", "content": f"Your previous response was invalid: {error}\n"
                                         "Reply again with only a single JSON value that validates against the JSON "
                                         "Schema. No prose, no code fences."}]


def _resolve(req: LlmRequest) -> tuple[TierConfig, float, float, str | None]:
    tc = get_llm_config().tiers[req.tier]
    temperature = req.temperature if req.temperature is not None else tc.default_temperature
    timeout_s = req.timeout_s if req.timeout_s is not None else tc.timeout_s
    key = llm_cache_key(req.tier, tc.target.model, req.system, req.messages, req.json_schema, temperature) if req.cacheable else None
    return tc, temperature, timeout_s, key


# --------------------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------------------


def complete(req: LlmRequest) -> LlmResult:
    _validate(req)
    tc, temperature, timeout_s, key = _resolve(req)
    if key:
        hit = _cache_get(key)
        if hit:
            _log_call(req, hit, None, None)
            return hit
    with span("llm.complete"):
        c, provider, latency = _complete_with_fallback(req, tc, req.messages, temperature, timeout_s)
        in_tok, out_tok = c.input_tokens, c.output_tokens
        parsed: Any = None
        if req.json_schema is not None:
            ok, val = parse_and_validate(c.text, req.json_schema)
            if not ok:
                _log.warning("llm output failed schema; retrying once", extra={"purpose": req.purpose, "error": str(val)[:300]})
                c, provider, latency = _complete_with_fallback(req, tc, _repair(req.messages, c.text, str(val)),
                                                              temperature, timeout_s)
                in_tok += c.input_tokens
                out_tok += c.output_tokens
                ok, val = parse_and_validate(c.text, req.json_schema)
                if not ok:
                    _log_call(req, LlmResult(c.text, c.model, in_tok, out_tok, False), provider, latency, badOutput=True)
                    raise LlmBadOutputError(req.purpose, str(val))
            parsed = val
        result = LlmResult(text=c.text, model=c.model, input_tokens=in_tok, output_tokens=out_tok, cached=False, json=parsed)
        if key:
            _cache_put(key, result, get_llm_config().cache_ttl_s)
        _log_call(req, result, provider, latency)
        return result


@dataclass
class LlmStream:
    """Iterate for text deltas; call final() for the LlmResult (drains the stream if needed)."""

    _gen: Iterator[str]
    _result: list[LlmResult] = field(default_factory=list)

    def __iter__(self) -> Iterator[str]:
        return self._gen

    def final(self) -> LlmResult:
        for _ in self._gen:
            pass
        if not self._result:
            raise KpError("INTERNAL", "LLM stream ended without a result")
        return self._result[0]


def stream(req: LlmRequest) -> LlmStream:
    """Fallback only before the first delta; a jsonSchema stream is validated at the end without repair."""
    _validate(req)
    tc, temperature, timeout_s, key = _resolve(req)
    out: list[LlmResult] = []

    def gen() -> Iterator[str]:
        if key:
            hit = _cache_get(key)
            if hit:
                if hit.text:
                    yield hit.text
                _log_call(req, hit, None, None, streamed=True)
                out.append(hit)
                return
        targets = _targets(tc)
        last: BaseException | None = None
        for i, target in enumerate(targets):
            started = time.monotonic()
            text, emitted = "", False
            in_tok: int | None = None
            out_tok: int | None = None
            model = target.model
            try:
                for ev in get_llm_provider(target.provider).stream(_call(target, req, req.messages, temperature, timeout_s)):
                    if ev.kind == "delta":
                        text += ev.text
                        emitted = True
                        yield ev.text
                    else:
                        in_tok = ev.input_tokens if ev.input_tokens is not None else in_tok
                        out_tok = ev.output_tokens if ev.output_tokens is not None else out_tok
                        model = ev.model or model
            except GeneratorExit:
                _record(req.purpose, target, in_tok or _estimate(req.system), out_tok or _estimate(text),
                        req.account_id, req.correlation_id, req.job_type)
                raise
            except Exception as e:  # noqa: BLE001
                last = e
                if emitted or not _fallback_eligible(e) or i == len(targets) - 1:
                    if emitted:
                        _record(req.purpose, target, in_tok or _estimate(req.system), out_tok or _estimate(text),
                                req.account_id, req.correlation_id, req.job_type)
                    raise _map_error(e, req.purpose, target.provider) from e
                _log.warning("llm stream primary failed before output; retrying on fallback",
                             extra={"purpose": req.purpose, "provider": target.provider, "err": str(e)})
                continue
            prompt_chars = req.system + "".join(m["content"] for m in req.messages)
            in_n = in_tok if in_tok is not None else _estimate(prompt_chars)
            out_n = out_tok if out_tok is not None else _estimate(text)
            _record(req.purpose, target, in_n, out_n, req.account_id, req.correlation_id, req.job_type)
            latency = int((time.monotonic() - started) * 1000)
            parsed: Any = None
            if req.json_schema is not None:
                ok, val = parse_and_validate(text, req.json_schema)
                if not ok:
                    _log_call(req, LlmResult(text, model, in_n, out_n, False), target.provider, latency,
                              streamed=True, badOutput=True)
                    raise LlmBadOutputError(req.purpose, str(val))
                parsed = val
            result = LlmResult(text=text, model=model, input_tokens=in_n, output_tokens=out_n, cached=False, json=parsed)
            if key:
                _cache_put(key, result, get_llm_config().cache_ttl_s)
            _log_call(req, result, target.provider, latency, streamed=True)
            out.append(result)
            return
        if last is not None:
            raise _map_error(last, req.purpose, targets[-1].provider)

    return LlmStream(gen(), out)


def embed(texts: list[str], *, purpose: str = "embed", pii_free: bool = True, account_id: str | None = None,
          correlation_id: str | None = None, job_type: str | None = None,
          timeout_s: float | None = None) -> list[list[float]]:
    """Embedding tier (LLD extension): batches of embed_batch_size (128), dimension-checked (1024)."""
    if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
        raise KpError("VALIDATION", "embed(texts) requires a list of strings")
    if pii_free:
        assert_no_pii(purpose, texts)
    if not texts:
        return []
    cfg = get_llm_config()
    tc = cfg.tiers["embed"]
    t_s = timeout_s if timeout_s is not None else tc.timeout_s
    out: list[list[float]] = []
    total = 0
    with span("llm.embed"):
        for start in range(0, len(texts), cfg.embed_batch_size):
            batch = [t or " " for t in texts[start : start + cfg.embed_batch_size]]
            targets = _targets(tc)
            for i, target in enumerate(targets):
                try:
                    res = get_llm_provider(target.provider).embed(target.model, batch, tc.dimensions, target.base_url, t_s)
                    tokens = res.input_tokens or sum(_estimate(t) for t in batch)
                    _record(purpose, target, tokens, 0, account_id, correlation_id, job_type)
                    if len(res.vectors) != len(batch):
                        raise LlmBadOutputError(purpose, f"expected {len(batch)} vectors, got {len(res.vectors)}")
                    for v in res.vectors:
                        if tc.dimensions is not None and len(v) != tc.dimensions:
                            raise LlmBadOutputError(purpose, f"expected {tc.dimensions}-dimensional vectors, got {len(v)}")
                    out.extend(res.vectors)
                    total += tokens
                    break
                except Exception as e:  # noqa: BLE001
                    if not _fallback_eligible(e) or i == len(targets) - 1:
                        raise _map_error(e, purpose, target.provider) from e
                    _log.warning("embed primary failed; retrying on fallback",
                                 extra={"purpose": purpose, "provider": target.provider, "err": str(e)})
    _log.info("llm embed", extra={"llm": {"purpose": purpose, "tier": "embed", "model": tc.target.model,
                                          "texts": len(texts), "inputTokens": total}})
    return out
