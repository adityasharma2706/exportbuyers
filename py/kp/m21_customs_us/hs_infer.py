"""M21 HS-heading inference for bills of lading without an HS code (LLD M21).

A missing HS code → the heading is inferred by **keyword** and **vector** match against the M12
heading descriptions of the current nomenclature:

- keyword: the share of the description's distinctive tokens found in the heading's description
  tokens (with light stemming), and a fuzzy token-set ratio (rapidfuzz), whichever is higher;
- vector: cosine similarity between the M03 embedding of the BOL description and the heading's
  stored M12 embedding, rescaled so unrelated text scores ~0.

``confidence = 0.4·keyword + 0.6·vector`` for the best heading, +0.1 (capped at 1) when both methods
put the same heading first. Anything below ``HS_CONFIDENCE_MIN`` (0.6) is dropped from aggregates.
Descriptions that look like they contain personal data are never sent to the embedding model; they
are matched on keywords only.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

import numpy as np

from kp.m01_platform import KpError, get_logger, get_secret
from kp.m03_llm import detect_pii, embed

from .models import DECLARED_HS_CONFIDENCE, HS_CONFIDENCE_MIN, BolRow, HsMethod

_log = get_logger("kp.m21_customs_us.hs_infer")

W_KEYWORD = 0.4
W_VECTOR = 0.6
AGREEMENT_BONUS = 0.1
VECTOR_FLOOR = 0.3          # cosine at or below this counts as no similarity [tunable]
EMBED_BATCH = 128
MAX_DESC_CHARS = 500

EmbedFn = Callable[[list[str]], list[list[float]]]

_TOKEN = re.compile(r"[a-z]+")
STOPWORDS = frozenset("""
a an and are as at be by for from in into is it of on or other others than that the their this to with
without whether not nes n e s thereof such kind kinds used type types parts part article articles
pcs pc pkg pkgs package packages carton cartons ctn ctns pallet pallets plt plts bag bags box boxes case
cases container containers said contain contains containing stc shipper load count hs code hts no nos
qty quantity total gross net weight kg kgs lbs lb freight prepaid collect invoice po order ref
""".split())


def _stem(t: str) -> str:
    for suf in ("ies", "es", "s"):
        if len(t) > 4 and t.endswith(suf):
            return t[: -len(suf)] + ("y" if suf == "ies" else "")
    return t


def tokens(text: str | None) -> frozenset[str]:
    if not text:
        return frozenset()
    return frozenset(_stem(t) for t in _TOKEN.findall(text.lower()) if len(t) > 2 and t not in STOPWORDS)


@dataclass(frozen=True)
class Heading:
    code: str
    description: str
    tokens: frozenset[str]
    embedding: tuple[float, ...] | None
    norm: float


@dataclass(frozen=True)
class Inference:
    heading: str | None
    confidence: float
    method: HsMethod


class HeadingIndex:
    """The current nomenclature's headings with their tokens and embeddings."""

    def __init__(self, headings: Iterable[tuple[str, str, Sequence[float] | None]]) -> None:
        self.headings: list[Heading] = []
        self._by_token: dict[str, list[int]] = {}
        for code, desc, emb in headings:
            if not re.fullmatch(r"\d{4}", code or ""):
                continue
            vec = tuple(float(x) for x in emb) if emb else None
            norm = math.sqrt(sum(x * x for x in vec)) if vec else 0.0
            h = Heading(code=code, description=desc or "", tokens=tokens(desc), embedding=vec, norm=norm)
            idx = len(self.headings)
            self.headings.append(h)
            for t in h.tokens:
                self._by_token.setdefault(t, []).append(idx)
        if not self.headings:
            raise KpError("INTERNAL", "HS heading index is empty; is the M12 nomenclature loaded?")
        self.codes = frozenset(h.code for h in self.headings)
        # Unit-normalised embedding matrix for fast cosine over all headings at once.
        embedded = [h for h in self.headings if h.embedding is not None and h.norm > 0]
        dims = {len(h.embedding or ()) for h in embedded}
        self._vec_codes: list[str] = []
        self._matrix: np.ndarray | None = None
        if embedded and len(dims) == 1:
            self._vec_codes = [h.code for h in embedded]
            m = np.asarray([h.embedding for h in embedded], dtype=np.float32)
            self._matrix = m / np.linalg.norm(m, axis=1, keepdims=True)
        elif len(dims) > 1:
            _log.warning("heading embeddings have mixed dimensions; vector matching disabled", extra={"dims": sorted(dims)})

    def keyword_scores(self, desc: str) -> dict[str, float]:
        q = tokens(desc)
        if not q:
            return {}
        cand: set[int] = set()
        for t in q:
            cand.update(self._by_token.get(t, ()))
        out: dict[str, float] = {}
        try:
            from rapidfuzz import fuzz

            ratio: Callable[[str, str], float] | None = fuzz.token_set_ratio
        except ImportError:
            ratio = None
        ql = " ".join(sorted(q))
        for i in cand:
            h = self.headings[i]
            overlap = len(q & h.tokens) / len(q)
            fz = ratio(ql, " ".join(sorted(h.tokens))) / 100.0 if ratio else 0.0
            out[h.code] = max(overlap, fz * overlap ** 0.5)
        return out

    def vector_scores(self, vec: Sequence[float]) -> dict[str, float]:
        if self._matrix is None:
            return {}
        q = np.asarray(vec, dtype=np.float32)
        if q.shape != (self._matrix.shape[1],):
            return {}
        qn = float(np.linalg.norm(q))
        if qn <= 0 or not math.isfinite(qn):
            return {}
        cos = self._matrix @ (q / qn)
        scaled = np.clip((cos - VECTOR_FLOOR) / (1.0 - VECTOR_FLOOR), 0.0, 1.0)
        return {c: float(s) for c, s in zip(self._vec_codes, scaled.tolist()) if s > 0.0}


def infer(index: HeadingIndex, desc: str | None, vec: Sequence[float] | None) -> Inference:
    if not desc or not desc.strip():
        return Inference(None, 0.0, "none")
    kw = index.keyword_scores(desc)
    vs = index.vector_scores(vec) if vec is not None else {}
    if not kw and not vs:
        return Inference(None, 0.0, "none")
    kw_top = max(kw, key=lambda c: (kw[c], c)) if kw else None
    vs_top = max(vs, key=lambda c: (vs[c], c)) if vs else None
    if vec is None:
        # Keyword-only (no embedding available): the keyword score alone, so strong exact matches
        # can still pass the bar but weak ones cannot.
        assert kw_top is not None
        return Inference(kw_top, round(kw[kw_top], 4), "keyword")
    combined = {c: W_KEYWORD * kw.get(c, 0.0) + W_VECTOR * vs.get(c, 0.0) for c in set(kw) | set(vs)}
    best = max(combined, key=lambda c: (combined[c], c))
    conf = combined[best]
    agree = kw_top is not None and kw_top == vs_top == best
    if agree:
        conf = min(1.0, conf + AGREEMENT_BONUS)
    method: HsMethod = "keyword+vector" if agree else ("vector" if best == vs_top else "keyword")
    return Inference(best, round(conf, 4), method)


class HsInferer:
    """Assigns ``hs_heading`` / ``hs_confidence`` / ``hs_method`` to BOL rows, batching embeddings over
    distinct descriptions and caching results for the life of the object (one run)."""

    def __init__(self, index: HeadingIndex, embed_fn: EmbedFn | None = None, *, use_vectors: bool = True,
                 job_type: str = "m21.ingest_week") -> None:
        self.index = index
        self._embed = embed_fn or (lambda texts: embed(texts, purpose="embed", job_type=job_type))
        self.use_vectors = use_vectors
        self._cache: dict[str, Inference] = {}
        self.embed_failures = 0

    @staticmethod
    def _key(desc: str) -> str:
        return " ".join(desc.lower().split())[:MAX_DESC_CHARS]

    def _vectors(self, texts: list[str]) -> dict[str, list[float] | None]:
        out: dict[str, list[float] | None] = {t: None for t in texts}
        if not self.use_vectors:
            return out
        safe = [t for t in texts if not detect_pii(t)]
        for i in range(0, len(safe), EMBED_BATCH):
            batch = safe[i:i + EMBED_BATCH]
            try:
                vecs = self._embed(batch)
            except KpError as e:
                # Embeddings unavailable: fall back to keywords for this batch rather than fail the run.
                self.embed_failures += 1
                _log.warning("embedding batch failed; keyword-only inference", extra={"code": e.code, "n": len(batch)})
                continue
            if len(vecs) != len(batch):
                self.embed_failures += 1
                continue
            for t, v in zip(batch, vecs):
                out[t] = v
        return out

    def apply(self, rows: Sequence[BolRow]) -> tuple[int, int, int]:
        """Returns (declared, inferred ≥ threshold, dropped)."""
        declared = inferred = dropped = 0
        pending: list[str] = []
        queued: set[str] = set()
        for r in rows:
            if r.hs_code and len(r.hs_code) >= 4 and r.hs_code[:4] in self.index.codes:
                continue
            if r.description:
                k = self._key(r.description)
                if k not in self._cache and k not in queued:
                    queued.add(k)
                    pending.append(k)
        if pending:
            vecs = self._vectors(pending)
            for k in pending:
                self._cache[k] = infer(self.index, k, vecs.get(k))
        for r in rows:
            if r.hs_code and len(r.hs_code) >= 4 and r.hs_code[:4] in self.index.codes:
                r.hs_heading, r.hs_confidence, r.hs_method = r.hs_code[:4], DECLARED_HS_CONFIDENCE, "declared"
                declared += 1
                continue
            res = self._cache.get(self._key(r.description)) if r.description else None
            if res is None or res.heading is None:
                r.hs_heading, r.hs_confidence, r.hs_method = None, 0.0, "none"
                dropped += 1
                continue
            r.hs_heading, r.hs_confidence, r.hs_method = res.heading, res.confidence, res.method
            if res.confidence >= HS_CONFIDENCE_MIN:
                inferred += 1
            else:
                dropped += 1
        return declared, inferred, dropped


def _parse_vector(text: str | None) -> list[float] | None:
    if not text:
        return None
    s = text.strip().lstrip("[").rstrip("]")
    if not s:
        return None
    try:
        return [float(x) for x in s.split(",")]
    except ValueError:
        return None


def pg_heading_index() -> HeadingIndex:
    """Headings of the current HS nomenclature (M12 ``knowledge.hs_code``) with embeddings."""
    import psycopg

    with psycopg.connect(get_secret("DATABASE_URL")) as conn:
        rows = conn.execute(
            "select c.code, coalesce(c.description_en_simple, c.description), c.embedding::text "
            "from knowledge.hs_code c join knowledge.hs_version v on v.version = c.version "
            "where v.is_current and c.level = 'heading' and v.version = ("
            "  select v2.version from knowledge.hs_version v2 join knowledge.hs_code c2 on c2.version = v2.version "
            "  where v2.is_current and c2.level = 'heading' order by v2.loaded_at desc limit 1)"
        ).fetchall()
    return HeadingIndex((str(r[0]), str(r[1] or ""), _parse_vector(r[2])) for r in rows)
