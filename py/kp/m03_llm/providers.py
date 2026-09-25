"""M03 providers (Python mirror of providers.ts): anthropic, openai(-compatible), voyage.

API keys come from the secrets bundle as ``<PROVIDER>_API_KEY``.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterator, Protocol

import httpx

from kp.m01_platform import KpError, get_secret


@dataclass
class ProviderCall:
    model: str
    max_tokens: int
    system: str
    messages: list[dict[str, str]]
    temperature: float
    timeout_s: float
    json_schema: dict[str, Any] | None = None
    base_url: str | None = None


@dataclass
class ProviderCompletion:
    text: str
    model: str
    input_tokens: int
    output_tokens: int


@dataclass
class StreamEvent:
    """kind = 'delta' (text) or 'usage' (token counts / model)."""

    kind: str
    text: str = ""
    input_tokens: int | None = None
    output_tokens: int | None = None
    model: str | None = None


@dataclass
class ProviderEmbedding:
    vectors: list[list[float]]
    model: str
    input_tokens: int


class ProviderHttpError(Exception):
    """HTTP failure from a provider; status 0 = network error."""

    def __init__(self, provider: str, status: int, message: str) -> None:
        super().__init__(message)
        self.provider = provider
        self.status = status


class ProviderTimeout(Exception):
    pass


class LlmProvider(Protocol):
    name: str

    def complete(self, call: ProviderCall) -> ProviderCompletion: ...

    def stream(self, call: ProviderCall) -> Iterator[StreamEvent]: ...

    def embed(self, model: str, texts: list[str], dimensions: int | None, base_url: str | None,
              timeout_s: float) -> ProviderEmbedding: ...


def json_instruction(schema: dict[str, Any]) -> str:
    return (
        "\n\nRespond with only a single JSON value that validates against the following JSON Schema. "
        "Do not include prose, explanations or code fences.\nJSON Schema:\n" + json.dumps(schema)
    )


def _api_key(provider: str) -> str:
    return get_secret(re.sub(r"[^A-Z0-9]", "_", provider.upper()) + "_API_KEY")


def _num(v: Any) -> int | None:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _raise_for(provider: str, res: httpx.Response) -> None:
    if res.status_code >= 400:
        try:
            detail = res.read().decode("utf-8", "replace")[:500]
        except Exception:  # noqa: BLE001 - best effort detail
            detail = ""
        raise ProviderHttpError(provider, res.status_code, f"{provider}: HTTP {res.status_code} {detail}")


def _post(provider: str, url: str, headers: dict[str, str], body: dict[str, Any], timeout_s: float) -> Any:
    try:
        res = httpx.post(url, headers=headers, json=body, timeout=timeout_s)
    except httpx.TimeoutException as e:
        raise ProviderTimeout(str(e)) from e
    except httpx.HTTPError as e:
        raise ProviderHttpError(provider, 0, f"{provider}: network error") from e
    _raise_for(provider, res)
    return res.json()


def _sse(provider: str, url: str, headers: dict[str, str], body: dict[str, Any], timeout_s: float) -> Iterator[tuple[str, str]]:
    """Yields (event, data) SSE records. timeout_s bounds the whole stream."""
    import time

    deadline = time.monotonic() + timeout_s
    try:
        with httpx.stream("POST", url, headers=headers, json=body, timeout=timeout_s) as res:
            _raise_for(provider, res)
            event, data = "message", []
            for line in res.iter_lines():
                if time.monotonic() > deadline:
                    raise ProviderTimeout(f"{provider}: stream exceeded {timeout_s}s")
                if line == "":
                    if data:
                        yield event, "\n".join(data)
                    event, data = "message", []
                    continue
                if line.startswith(":"):
                    continue
                field, _, val = line.partition(":")
                val = val[1:] if val.startswith(" ") else val
                if field == "event":
                    event = val
                elif field == "data":
                    data.append(val)
            if data:
                yield event, "\n".join(data)
    except httpx.TimeoutException as e:
        raise ProviderTimeout(str(e)) from e
    except httpx.HTTPError as e:
        raise ProviderHttpError(provider, 0, f"{provider}: network error") from e


class AnthropicProvider:
    name = "anthropic"
    base = "https://api.anthropic.com"

    def _body(self, call: ProviderCall, stream: bool) -> dict[str, Any]:
        system = call.system + json_instruction(call.json_schema) if call.json_schema else call.system
        body: dict[str, Any] = {
            "model": call.model,
            "max_tokens": call.max_tokens,
            "messages": call.messages,
            "temperature": min(1.0, call.temperature),
        }
        if system:
            body["system"] = system
        if stream:
            body["stream"] = True
        return body

    def _headers(self) -> dict[str, str]:
        return {"x-api-key": _api_key("anthropic"), "anthropic-version": "2023-06-01"}

    def complete(self, call: ProviderCall) -> ProviderCompletion:
        j = _post(self.name, (call.base_url or self.base).rstrip("/") + "/v1/messages", self._headers(),
                  self._body(call, False), call.timeout_s)
        text = "".join(c.get("text", "") for c in j.get("content") or [] if c.get("type") == "text")
        usage = j.get("usage") or {}
        return ProviderCompletion(text, j.get("model") or call.model, _num(usage.get("input_tokens")) or 0,
                                  _num(usage.get("output_tokens")) or 0)

    def stream(self, call: ProviderCall) -> Iterator[StreamEvent]:
        url = (call.base_url or self.base).rstrip("/") + "/v1/messages"
        for event, data in _sse(self.name, url, self._headers(), self._body(call, True), call.timeout_s):
            try:
                j = json.loads(data)
            except json.JSONDecodeError:
                continue
            t = j.get("type") or event
            if t == "message_start":
                msg = j.get("message") or {}
                u = msg.get("usage") or {}
                yield StreamEvent("usage", input_tokens=_num(u.get("input_tokens")),
                                  output_tokens=_num(u.get("output_tokens")), model=msg.get("model"))
            elif t == "content_block_delta":
                d = j.get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    yield StreamEvent("delta", text=d["text"])
            elif t == "message_delta":
                u = j.get("usage") or {}
                yield StreamEvent("usage", input_tokens=_num(u.get("input_tokens")), output_tokens=_num(u.get("output_tokens")))
            elif t == "error":
                err = j.get("error") or {}
                status = 400 if err.get("type") == "invalid_request_error" else 529
                raise ProviderHttpError(self.name, status, f"anthropic stream error: {err.get('type', 'unknown')}")
            elif t == "message_stop":
                return

    def embed(self, model: str, texts: list[str], dimensions: int | None, base_url: str | None,
              timeout_s: float) -> ProviderEmbedding:
        raise KpError("INTERNAL", "anthropic provider does not support embeddings")


def _openai_style_embed(provider: str, base: str, dims_field: str, model: str, texts: list[str],
                        dimensions: int | None, timeout_s: float) -> ProviderEmbedding:
    body: dict[str, Any] = {"model": model, "input": texts}
    if dimensions is not None:
        body[dims_field] = dimensions
    j = _post(provider, base.rstrip("/") + "/v1/embeddings", {"authorization": f"Bearer {_api_key(provider)}"},
              body, timeout_s)
    data = sorted(j.get("data") or [], key=lambda d: d.get("index", 0))
    vectors: list[list[float]] = []
    for d in data:
        emb = d.get("embedding")
        if not isinstance(emb, list) or not all(isinstance(x, (int, float)) for x in emb):
            raise ProviderHttpError(provider, 502, f"{provider}: embedding response is malformed")
        vectors.append([float(x) for x in emb])
    usage = j.get("usage") or {}
    return ProviderEmbedding(vectors, j.get("model") or model,
                             _num(usage.get("total_tokens")) or _num(usage.get("prompt_tokens")) or 0)


class OpenAIProvider:
    name = "openai"
    base = "https://api.openai.com"

    def _body(self, call: ProviderCall, stream: bool) -> dict[str, Any]:
        messages = ([{"role": "system", "content": call.system}] if call.system else []) + call.messages
        body: dict[str, Any] = {"model": call.model, "max_tokens": call.max_tokens, "messages": messages,
                                "temperature": call.temperature}
        if call.json_schema:
            body["response_format"] = {"type": "json_schema",
                                       "json_schema": {"name": "output", "schema": call.json_schema, "strict": False}}
        if stream:
            body["stream"] = True
            body["stream_options"] = {"include_usage": True}
        return body

    def _headers(self) -> dict[str, str]:
        return {"authorization": f"Bearer {_api_key('openai')}"}

    def complete(self, call: ProviderCall) -> ProviderCompletion:
        j = _post(self.name, (call.base_url or self.base).rstrip("/") + "/v1/chat/completions", self._headers(),
                  self._body(call, False), call.timeout_s)
        choices = j.get("choices") or [{}]
        usage = j.get("usage") or {}
        return ProviderCompletion(((choices[0].get("message") or {}).get("content")) or "", j.get("model") or call.model,
                                  _num(usage.get("prompt_tokens")) or 0, _num(usage.get("completion_tokens")) or 0)

    def stream(self, call: ProviderCall) -> Iterator[StreamEvent]:
        url = (call.base_url or self.base).rstrip("/") + "/v1/chat/completions"
        for _event, data in _sse(self.name, url, self._headers(), self._body(call, True), call.timeout_s):
            if data == "[DONE]":
                return
            try:
                j = json.loads(data)
            except json.JSONDecodeError:
                continue
            if j.get("error"):
                raise ProviderHttpError(self.name, 500, f"openai stream error: {j['error'].get('message', 'unknown')}")
            choices = j.get("choices") or []
            text = ((choices[0].get("delta") or {}).get("content")) if choices else None
            if text:
                yield StreamEvent("delta", text=text)
            u = j.get("usage")
            if u:
                yield StreamEvent("usage", input_tokens=_num(u.get("prompt_tokens")),
                                  output_tokens=_num(u.get("completion_tokens")), model=j.get("model"))

    def embed(self, model: str, texts: list[str], dimensions: int | None, base_url: str | None,
              timeout_s: float) -> ProviderEmbedding:
        return _openai_style_embed("openai", base_url or self.base, "dimensions", model, texts, dimensions, timeout_s)


class VoyageProvider:
    name = "voyage"

    def complete(self, call: ProviderCall) -> ProviderCompletion:
        raise KpError("INTERNAL", "voyage provider supports embeddings only")

    def stream(self, call: ProviderCall) -> Iterator[StreamEvent]:
        raise KpError("INTERNAL", "voyage provider supports embeddings only")

    def embed(self, model: str, texts: list[str], dimensions: int | None, base_url: str | None,
              timeout_s: float) -> ProviderEmbedding:
        return _openai_style_embed("voyage", base_url or "https://api.voyageai.com", "output_dimension", model, texts,
                                   dimensions, timeout_s)


_registry: dict[str, LlmProvider] = {
    "anthropic": AnthropicProvider(),
    "openai": OpenAIProvider(),
    "voyage": VoyageProvider(),
}


def register_llm_provider(p: LlmProvider) -> None:
    _registry[p.name] = p


def unregister_llm_provider(name: str) -> None:
    _registry.pop(name, None)


def get_llm_provider(name: str) -> LlmProvider:
    p = _registry.get(name)
    if p is None:
        raise KpError("INTERNAL", f"LLM provider {name!r} is not registered")
    return p
