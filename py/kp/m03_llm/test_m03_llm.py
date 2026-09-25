"""M03 tests (Python): cache, schema repair, fallback, PII guard, stream, embed. No network."""
from __future__ import annotations

from typing import Any, Iterator

import pytest

from kp.m01_platform import KpError
from kp.m03_llm import (
    LlmBadOutputError,
    LlmRequest,
    ProviderCall,
    ProviderCompletion,
    ProviderEmbedding,
    ProviderHttpError,
    StreamEvent,
    build_llm_config,
    complete,
    detect_pii,
    embed,
    register_llm_provider,
    set_llm_cache_client_for_testing,
    set_llm_config_for_testing,
    stream,
    unregister_llm_provider,
)


class FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    def get(self, k: str) -> str | None:
        return self.store.get(k)

    def set(self, k: str, v: str, ex: int | None = None) -> None:
        self.store[k] = v

    def delete(self, k: str) -> None:
        self.store.pop(k, None)


class Fake:
    def __init__(self, name: str, replies: list[Any]) -> None:
        self.name = name
        self.replies = replies
        self.calls: list[ProviderCall] = []

    def _next(self) -> str:
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    def complete(self, call: ProviderCall) -> ProviderCompletion:
        self.calls.append(call)
        return ProviderCompletion(self._next(), call.model, 10, 5)

    def stream(self, call: ProviderCall) -> Iterator[StreamEvent]:
        self.calls.append(call)
        text = self._next()
        yield StreamEvent("usage", input_tokens=10, model=call.model)
        for i in range(0, len(text), 3):
            yield StreamEvent("delta", text=text[i : i + 3])
        yield StreamEvent("usage", output_tokens=5)

    def embed(self, model: str, texts: list[str], dimensions: int | None, base_url: str | None,
              timeout_s: float) -> ProviderEmbedding:
        return ProviderEmbedding([[0.5] * 4 for _ in texts], model, len(texts))


def _cfg(fallback: bool) -> Any:
    classify: dict[str, Any] = {"provider": "fake-a", "model": "small"}
    if fallback:
        classify["fallback"] = {"provider": "fake-b", "model": "small-b", "maxTokens": 100,
                                "inputMicrosInrPerMTok": 1, "outputMicrosInrPerMTok": 1}
    return build_llm_config({"tiers": {"classify": classify, "draft": {"provider": "fake-a", "model": "big"},
                                       "embed": {"provider": "fake-a", "model": "emb", "dimensions": 4}},
                             "embedBatchSize": 2})


REQ = dict(tier="classify", purpose="test.classify", system="Classify.",
           messages=[{"role": "user", "content": "Acme imports cotton yarn under HS 5205."}], pii_free=True)


@pytest.fixture(autouse=True)
def _setup(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeRedis]:
    import kp.m03_llm.adapter as adapter

    monkeypatch.setattr(adapter, "record_cost", lambda **kw: None)
    r = FakeRedis()
    set_llm_cache_client_for_testing(r)
    set_llm_config_for_testing(_cfg(False))
    yield r
    for n in ("fake-a", "fake-b"):
        unregister_llm_provider(n)
    set_llm_cache_client_for_testing(None)
    set_llm_config_for_testing(None)


def test_cache_hit_skips_provider() -> None:
    a = Fake("fake-a", ["importer"])
    register_llm_provider(a)
    assert complete(LlmRequest(**REQ, cacheable=True)).cached is False
    r2 = complete(LlmRequest(**REQ, cacheable=True))
    assert r2.cached is True and r2.text == "importer" and len(a.calls) == 1


def test_schema_repair_then_bad_output() -> None:
    schema = {"type": "object", "required": ["label"], "properties": {"label": {"enum": ["importer", "other"]}}}
    a = Fake("fake-a", ["nope", '{"label":"importer"}'])
    register_llm_provider(a)
    assert complete(LlmRequest(**REQ, json_schema=schema)).json == {"label": "importer"}
    assert len(a.calls[1].messages) == 3
    register_llm_provider(Fake("fake-a", ['{"label":"x"}', '{"label":"y"}']))
    with pytest.raises(LlmBadOutputError):
        complete(LlmRequest(**REQ, json_schema=schema))


def test_fallback_then_upstream_unavailable() -> None:
    set_llm_config_for_testing(_cfg(True))
    register_llm_provider(Fake("fake-a", [ProviderHttpError("fake-a", 503, "down")]))
    register_llm_provider(Fake("fake-b", ["other"]))
    assert complete(LlmRequest(**REQ)).text == "other"
    register_llm_provider(Fake("fake-a", [ProviderHttpError("fake-a", 500, "down")]))
    register_llm_provider(Fake("fake-b", [ProviderHttpError("fake-b", 502, "down")]))
    with pytest.raises(KpError) as ei:
        complete(LlmRequest(**REQ))
    assert ei.value.code == "UPSTREAM_UNAVAILABLE"


def test_pii_guard() -> None:
    register_llm_provider(Fake("fake-a", ["x"]))
    bad = dict(REQ, messages=[{"role": "user", "content": "mail ravi@example.com"}])
    with pytest.raises(KpError) as ei:
        complete(LlmRequest(**bad))
    assert ei.value.code == "VALIDATION"
    assert detect_pii("call +91 98765 43210") == ["phone"]
    assert detect_pii("HS 9403.60.1000 and 8517.62") == []


def test_stream_and_embed() -> None:
    register_llm_provider(Fake("fake-a", ["hello world"]))
    s = stream(LlmRequest(**dict(REQ, tier="draft", pii_free=False)))
    assert "".join(s) == "hello world"
    f = s.final()
    assert (f.text, f.input_tokens, f.output_tokens) == ("hello world", 10, 5)
    v = embed(["a", "b", "c"])
    assert len(v) == 3 and len(v[0]) == 4
