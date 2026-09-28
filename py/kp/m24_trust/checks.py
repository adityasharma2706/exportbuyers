"""M24 pluggable checks (LLD M24 "Checks" table).

Each check is ``run(subject, ctx) -> CheckOutcome``. ``ctx`` carries the run's transaction (for a
canonical company, or ``None`` for M32's ad hoc use — see ``models.TrustSubject``), the resolved
``Company`` row when there is one, and the per-vendor-call budget. Checks that use an outbound
vendor call wrap only that call with ``budget.run_with_budget``; a check that also records
supporting evidence in M09 (``registered_entity``, ``domain_age``) does that write afterwards,
synchronously and without a cancellable timeout — see ``budget.py`` for why.

Gaps in the LLD's three-outcome tables (a value that is neither clearly a pass nor a fail, e.g. a
domain age of one year, or trade activity last seen 18 months ago) are mapped to ``unknown``: the
vocabulary allows only pass / fail / unknown (``kp.m09_evidence`` ``TRUST_OUTCOMES``), so a signal
that is inconclusive by the LLD's own thresholds is reported the same way as a missing one.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

from kp.m01_platform import KpError, get_logger
from kp.m08_sources import ProhibitedHost, RobotsDisallowed, http_fetch
from kp.m09_evidence import Company, get_assertions
from kp.m10_policy import is_suppressed
from kp.m17_sanctions import screen_company, screen_name
from kp.m23_registry import (
    STRONG_MATCH,
    DomainSignals,
    InvalidDomain,
    RegistryMatch,
    Unavailable,
    domain_signals,
    is_freemail,
    name_similarity,
    normalise_domain,
    record_domain_signals,
    record_registry_match,
    registry_lookup,
)

from .budget import CHECK_BUDGET_S, run_with_budget, submit, wait_for
from .models import CheckOutcome, TrustSubject, utcnow

_log = get_logger("kp.m24_trust.checks")

DOMAIN_AGE_PASS_DAYS = 730     # [tunable] LLD M24: domain_age pass >= 2 years
DOMAIN_AGE_FAIL_DAYS = 183     # [tunable] LLD M24: domain_age fail < 6 months
TRADE_PASS_MONTHS = 12         # [tunable] LLD M24: recent_trade pass <= 12 months
TRADE_FAIL_MONTHS = 24         # [tunable] LLD M24: recent_trade fail > 24 months
WEBSITE_NAME_SIM = 0.8         # [tunable] LLD M24: website_consistent name match threshold
WEBSITE_FETCH_TIMEOUT_S = 2.5  # [tunable] leaves headroom inside the 3 s check budget
_PARKED_MARKERS: tuple[str, ...] = (
    "domain is parked", "this domain is parked", "buy this domain", "this domain is for sale",
    "domain for sale", "this domain may be for sale", "future home of something quite cool",
    "parking page", "godaddy.com/park", "sedoparking", "namebright", "hugedomains",
)
_TITLE_RE = re.compile(rb"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_OGSITE_RE = re.compile(rb'property=["\']og:site_name["\'][^>]*content=["\']([^"\']*)["\']', re.IGNORECASE)
_TITLE_SPLIT_RE = re.compile(r"\s*[|–—:]\s*|\s+-\s+")


@dataclass
class CheckContext:
    """Everything a check needs beyond the subject.

    ``tx`` is an open transaction (a psycopg connection, or an M09 ``EvidenceRepo``) when the run
    writes supporting evidence for a canonical company; ``None`` for the ad hoc, no-writes path.
    ``record`` gates every M09 write (it is always False when ``tx`` is None).
    """

    tx: Any = None
    company: Company | None = None
    record: bool = False
    now: datetime = field(default_factory=utcnow)
    budget_s: float = CHECK_BUDGET_S


class Check(Protocol):
    def __call__(self, subject: TrustSubject, ctx: CheckContext) -> CheckOutcome: ...


def _outcome(check_id: str, outcome: str, ctx_now: datetime, reason: str | None = None,
            assertion_id: str | None = None, detail: dict[str, Any] | None = None) -> CheckOutcome:
    key = f"trust.check.{check_id}.{outcome}" + (f".{reason}" if reason else "")
    return CheckOutcome(check_id=check_id, outcome=outcome, checked_at=ctx_now, explanation_key=key,  # type: ignore[arg-type]
                       assertion_id=assertion_id, detail=detail or {})


def _active_id(ctx: CheckContext, attribute: str) -> str | None:
    """The current active assertion for this attribute on the company, if any (best effort)."""
    if ctx.company is None:
        return None
    try:
        rows = get_assertions(ctx.company.id, [attribute], tx=ctx.tx)
    except KpError:
        return None
    return rows[-1].id if rows else None


def _norm_domain(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        return normalise_domain(raw)
    except (InvalidDomain, KpError):
        return None


def _company_domain(subject: TrustSubject, ctx: CheckContext) -> str | None:
    """The subject's own (website) domain — never an e-mail provider's domain."""
    for candidate in (subject.domain, subject.website):
        d = _norm_domain(candidate)
        if d:
            return d
    if ctx.company is not None and ctx.company.primary_domain:
        d = _norm_domain(ctx.company.primary_domain)
        if d:
            return d
    # Last resort for ad hoc input with only an e-mail: use its domain, unless it is free-mail
    # (a free-mail domain is never the company's own site).
    ed = _norm_domain(subject.email)
    if ed and not is_freemail(ed):
        return ed
    return None


def _company_name(subject: TrustSubject, ctx: CheckContext) -> str | None:
    return subject.name or (ctx.company.display_name if ctx.company else None)


def _company_country(subject: TrustSubject, ctx: CheckContext) -> str | None:
    c = subject.country or (ctx.company.country if ctx.company else None)
    return c.strip().upper() if c else None


# ---- registered_entity -----------------------------------------------------------------------

def check_registered_entity(subject: TrustSubject, ctx: CheckContext) -> CheckOutcome:
    cid = "registered_entity"
    name = _company_name(subject, ctx)
    country = _company_country(subject, ctx)
    if not name:
        return _outcome(cid, "unknown", ctx.now, "no_subject")
    if not country:
        return _outcome(cid, "unknown", ctx.now, "no_country")

    result = run_with_budget(
        lambda: registry_lookup(name, country), budget_s=ctx.budget_s,
        on_timeout=lambda: Unavailable(source="registry", reason="rate_limited", detail="check budget exceeded"),
        on_error=lambda e: Unavailable(source="registry", reason="upstream_error", detail=type(e).__name__),
    )
    if isinstance(result, Unavailable):
        return _outcome(cid, "unknown", ctx.now, result.reason, detail={"vendor": result.source})
    assert isinstance(result, RegistryMatch)
    if not result.matched:
        return _outcome(cid, "unknown", ctx.now, "no_match")

    aid = None
    if ctx.record and ctx.company is not None:
        aid = record_registry_match(ctx.tx, ctx.company.id, result)
        if aid is None:
            aid = _active_id(ctx, "registry.match")

    detail = {"status": result.status, "name_similarity": result.name_similarity, "source": result.source_id}
    if result.status == "dissolved":
        return _outcome(cid, "fail", ctx.now, "dissolved", assertion_id=aid, detail=detail)
    if result.name_similarity >= STRONG_MATCH:
        return _outcome(cid, "pass", ctx.now, None, assertion_id=aid, detail=detail)
    return _outcome(cid, "unknown", ctx.now, "weak_match", assertion_id=aid, detail=detail)


# ---- website_consistent ----------------------------------------------------------------------

def _page_name(body: bytes) -> str | None:
    m = _OGSITE_RE.search(body) or _TITLE_RE.search(body)
    if not m:
        return None
    text = m.group(1).decode("utf-8", errors="replace").strip()
    text = re.sub(r"&amp;", "&", text)
    if not text:
        return None
    return _TITLE_SPLIT_RE.split(text, maxsplit=1)[0].strip() or text


def _looks_parked(body: bytes) -> bool:
    low = body[:20_000].lower()
    return any(marker.encode("ascii", errors="ignore") in low for marker in _PARKED_MARKERS)


def check_website_consistent(subject: TrustSubject, ctx: CheckContext) -> CheckOutcome:
    cid = "website_consistent"
    domain = _company_domain(subject, ctx)
    name = _company_name(subject, ctx)
    if not domain:
        return _outcome(cid, "unknown", ctx.now, "no_domain")
    try:
        if is_suppressed("domain", domain):
            return _outcome(cid, "unknown", ctx.now, "suppressed")
    except KpError:
        pass  # an identifier IF-10c cannot normalise is not this check's problem

    def _fetch() -> tuple[int, bytes] | str:
        """A usable response, or a failure reason: 'blocked' (robots / prohibited host — the site
        may well be real, we simply could not check it) or 'unreachable' (DNS/connection/HTTP
        failure on every attempt)."""
        saw_blocked = False
        for scheme, host in (("https", domain), ("https", f"www.{domain}"), ("http", domain)):
            url = f"{scheme}://{host}/"
            try:
                resp = http_fetch(url, timeout=WEBSITE_FETCH_TIMEOUT_S)
            except (ProhibitedHost, RobotsDisallowed):
                saw_blocked = True
                continue
            except KpError:
                continue
            if 200 <= resp.status < 400 and resp.body:
                return resp.status, resp.body
        return "blocked" if saw_blocked else "unreachable"

    fetched = run_with_budget(_fetch, budget_s=ctx.budget_s, on_timeout=lambda: "timeout", on_error=lambda e: "error")
    if fetched in ("blocked", "timeout", "error"):
        # We could not check the site at all; that is not evidence it is fake.
        return _outcome(cid, "unknown", ctx.now, str(fetched), detail={"domain": domain})
    if fetched == "unreachable":
        return _outcome(cid, "fail", ctx.now, "unreachable", detail={"domain": domain})
    status, body = fetched
    if _looks_parked(body) or len(body) < 200:
        return _outcome(cid, "fail", ctx.now, "parked", detail={"domain": domain, "status": status})
    page_name = _page_name(body)
    if not page_name or not name:
        return _outcome(cid, "unknown", ctx.now, "no_page_name", detail={"domain": domain})
    sim = name_similarity(name, page_name)
    detail = {"domain": domain, "page_name": page_name, "name_similarity": sim}
    if sim >= WEBSITE_NAME_SIM:
        return _outcome(cid, "pass", ctx.now, None, detail=detail)
    return _outcome(cid, "fail", ctx.now, "name_mismatch", detail=detail)


# ---- domain_age -------------------------------------------------------------------------------

def check_domain_age(subject: TrustSubject, ctx: CheckContext) -> CheckOutcome:
    cid = "domain_age"
    domain = _company_domain(subject, ctx)
    if not domain:
        return _outcome(cid, "unknown", ctx.now, "no_domain")

    sig = run_with_budget(
        lambda: domain_signals(domain), budget_s=ctx.budget_s,
        on_timeout=lambda: None, on_error=lambda e: None,
    )
    if sig is None:
        return _outcome(cid, "unknown", ctx.now, "unavailable", detail={"domain": domain})
    assert isinstance(sig, DomainSignals)

    aid = None
    if ctx.record and ctx.company is not None:
        record_domain_signals(ctx.tx, ctx.company.id, sig, region=ctx.company.country)
        aid = _active_id(ctx, "domain.age_days")

    if sig.age_days is None:
        return _outcome(cid, "unknown", ctx.now, "unavailable", assertion_id=aid, detail={"domain": domain})
    detail = {"domain": domain, "age_days": sig.age_days}
    if sig.age_days >= DOMAIN_AGE_PASS_DAYS:
        return _outcome(cid, "pass", ctx.now, None, assertion_id=aid, detail=detail)
    if sig.age_days < DOMAIN_AGE_FAIL_DAYS:
        return _outcome(cid, "fail", ctx.now, "new_domain", assertion_id=aid, detail=detail)
    return _outcome(cid, "unknown", ctx.now, "inconclusive_age", assertion_id=aid, detail=detail)


# ---- corporate_email --------------------------------------------------------------------------

def _display_mask_domain(mask: str) -> str | None:
    if "@" not in mask:
        return None
    return mask.rsplit("@", 1)[1].strip().lower() or None


def check_corporate_email(subject: TrustSubject, ctx: CheckContext) -> CheckOutcome:
    cid = "corporate_email"
    company_domain = _company_domain(subject, ctx)

    candidates: list[tuple[str, str | None]] = []  # (email_domain, supporting_assertion_id)
    if ctx.company is not None:
        try:
            rows = get_assertions(ctx.company.id, ["contact.role_email"], tx=ctx.tx)
        except KpError:
            rows = []
        for a in rows:
            d = _display_mask_domain(str(a.value.get("display_mask") or ""))
            if d:
                candidates.append((d, a.id))
    elif subject.email:
        d = _norm_domain(subject.email)
        if d:
            candidates.append((d, None))

    if not candidates:
        return _outcome(cid, "unknown", ctx.now, "no_email")

    def _matches_company(d: str) -> bool:
        return company_domain is not None and (d == company_domain or d.endswith("." + company_domain))

    on_company = [(d, aid) for d, aid in candidates if _matches_company(d)]
    if on_company:
        d, aid = on_company[0]
        return _outcome(cid, "pass", ctx.now, None, assertion_id=aid, detail={"domain": d})

    freemail_only = all(is_freemail(d) for d, _ in candidates)
    if freemail_only:
        d, aid = candidates[0]
        return _outcome(cid, "fail", ctx.now, "freemail_only", assertion_id=aid, detail={"domain": d})
    # Non-free-mail address(es), but on a domain we cannot tie to the company (or the company's
    # own domain is unknown): neither a confirmed pass nor a demonstrated free-mail-only fail.
    d, aid = candidates[0]
    return _outcome(cid, "unknown", ctx.now, "unconfirmed_domain", assertion_id=aid, detail={"domain": d})


# ---- recent_trade -----------------------------------------------------------------------------

def _iso_date(v: Any) -> datetime | None:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if not isinstance(v, str):
        return None
    try:
        d = datetime.fromisoformat(v[:10])
        return d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def check_recent_trade(subject: TrustSubject, ctx: CheckContext) -> CheckOutcome:
    cid = "recent_trade"
    if ctx.company is None:
        # LLD: "always unknown without M21" — and without a company there is nothing M21 wrote.
        return _outcome(cid, "unknown", ctx.now, "no_customs_data")
    try:
        rows = get_assertions(ctx.company.id, ["activity_aggregate"], tx=ctx.tx)
    except KpError:
        rows = []
    best: tuple[datetime, str] | None = None
    for a in rows:
        d = _iso_date(a.value.get("last_seen"))
        if d is not None and (best is None or d > best[0]):
            best = (d, a.id)
    if best is None:
        return _outcome(cid, "unknown", ctx.now, "no_customs_data")
    last_seen, aid = best
    months = (ctx.now - last_seen).days / 30.44
    detail = {"last_seen": last_seen.date().isoformat(), "months_ago": round(months, 1)}
    if months <= TRADE_PASS_MONTHS:
        return _outcome(cid, "pass", ctx.now, None, assertion_id=aid, detail=detail)
    if months > TRADE_FAIL_MONTHS:
        return _outcome(cid, "fail", ctx.now, "stale", assertion_id=aid, detail=detail)
    return _outcome(cid, "unknown", ctx.now, "inconclusive_recency", assertion_id=aid, detail=detail)


# ---- sanctions --------------------------------------------------------------------------------

def check_sanctions(subject: TrustSubject, ctx: CheckContext) -> CheckOutcome:
    cid = "sanctions"
    try:
        if ctx.company is not None:
            # Local trigram matching against the already-ingested lists (M17): fast, DB-only, so
            # it is not wrapped in a cancellable budget — see budget.py.
            res = screen_company(ctx.company.id, tx=ctx.tx)
            aid = _active_id(ctx, "sanctions_flag")
        else:
            name = subject.name
            if not name:
                return _outcome(cid, "unknown", ctx.now, "no_subject")
            res = screen_name(name, subject.country)
            aid = None
    except KpError as e:
        return _outcome(cid, "unknown", ctx.now, "screener_unavailable", detail={"code": e.code})
    except Exception as e:  # noqa: BLE001 — the screener must never take a trust run down
        _log.warning("sanctions screen failed", extra={"error": type(e).__name__})
        return _outcome(cid, "unknown", ctx.now, "screener_unavailable")

    detail = {"result": res.result, "best_score": res.best_score}
    if res.result == "clear":
        return _outcome(cid, "pass", ctx.now, None, assertion_id=aid, detail=detail)
    return _outcome(cid, "fail", ctx.now, res.result, assertion_id=aid, detail=detail)


CHECKS: "dict[str, Check]" = {
    "registered_entity": check_registered_entity,
    "website_consistent": check_website_consistent,
    "domain_age": check_domain_age,
    "corporate_email": check_corporate_email,
    "recent_trade": check_recent_trade,
    "sanctions": check_sanctions,
}


def run_checks(subject: TrustSubject, ctx: CheckContext, *, concurrent: bool = False) -> dict[str, CheckOutcome]:
    """Runs every registered check. ``concurrent`` (only ever safe with ``ctx.tx is None``, i.e.
    the ad hoc no-writes path) runs the six checks in parallel so the ad hoc RPC's 8 s overall
    budget is not the sum of six 3 s per-check budgets; the EV-01 job path runs them one at a
    time, so a check's own M09 write is never touched from more than one thread."""
    if not concurrent:
        return {check_id: fn(subject, ctx) for check_id, fn in CHECKS.items()}
    if ctx.tx is not None:
        raise KpError("INTERNAL", "concurrent check execution requires ctx.tx to be None")
    futures = {check_id: submit(lambda fn=fn: fn(subject, ctx)) for check_id, fn in CHECKS.items()}
    return {
        check_id: wait_for(
            fut, budget_s=ctx.budget_s + 1.0,
            on_timeout=lambda cid=check_id: _outcome(cid, "unknown", ctx.now, "timeout"),
            on_error=lambda e, cid=check_id: _outcome(cid, "unknown", ctx.now, "error"),
        )
        for check_id, fut in futures.items()
    }
