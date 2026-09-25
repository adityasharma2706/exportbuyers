"""M12 description embeddings through M03 ``embed`` (tier ``embed``, 1024 dimensions).

Embeddings already stored for the same text in the same version are reused so a reload of an
edition whose descriptions did not change costs nothing. Texts flagged by the M03 PII guard are
not sent (nomenclature text should never contain personal data; a hit means a malformed row) —
the row is stored without an embedding and a warning is returned.
"""
from __future__ import annotations

import math
from typing import Callable, Mapping, Sequence

from kp.m01_platform import KpError, get_logger
from kp.m03_llm import detect_pii, embed

from .models import EMBEDDING_DIM, HsCodeRow

EMBED_BATCH_SIZE = 128  # LLD M12
EmbedFn = Callable[..., list[list[float]]]

_log = get_logger("kp.m12_hs.embeddings")


def _check_vector(v: Sequence[float]) -> list[float]:
    if len(v) != EMBEDDING_DIM:
        raise KpError("UPSTREAM_UNAVAILABLE", f"embedding has {len(v)} dimensions, expected {EMBEDDING_DIM}")
    out = [float(x) for x in v]
    if not all(math.isfinite(x) for x in out):
        raise KpError("UPSTREAM_UNAVAILABLE", "embedding contains non-finite values")
    return out


def embed_rows(
    rows: Sequence[HsCodeRow],
    *,
    reuse: Mapping[str, list[float]] | None = None,
    embed_fn: EmbedFn | None = None,
    correlation_id: str | None = None,
) -> tuple[int, int, list[str]]:
    """Sets ``row.embedding`` for every row. Returns (embedded, reused, warnings)."""
    fn = embed_fn or embed
    reuse = reuse or {}
    warnings: list[str] = []
    pending: list[HsCodeRow] = []
    reused = 0
    for r in rows:
        text = r.embed_text()
        hit = reuse.get(text)
        if hit is not None and len(hit) == EMBEDDING_DIM:
            r.embedding = list(hit)
            reused += 1
            continue
        kinds = detect_pii(text)
        if kinds:
            warnings.append(f"{r.code}: description matched PII pattern(s) {sorted(kinds)}; not embedded")
            r.embedding = None
            continue
        pending.append(r)

    embedded = 0
    for start in range(0, len(pending), EMBED_BATCH_SIZE):
        batch = pending[start : start + EMBED_BATCH_SIZE]
        vectors = fn([r.embed_text() for r in batch], purpose="m12.hs_description", pii_free=True,
                     correlation_id=correlation_id, job_type="m12.load")
        if len(vectors) != len(batch):
            raise KpError("UPSTREAM_UNAVAILABLE", f"embed returned {len(vectors)} vectors for {len(batch)} texts")
        for r, v in zip(batch, vectors):
            r.embedding = _check_vector(v)
        embedded += len(batch)
    _log.info("hs descriptions embedded", extra={"embedded": embedded, "reused": reused, "skipped": len(warnings)})
    return embedded, reused, warnings
