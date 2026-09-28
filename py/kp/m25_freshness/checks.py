"""M25 per-kind checks (LLD M25 "Per kind").

- **Email**: MX check first, then the email-verification vendor.
- **Phone / WhatsApp**: libphonenumber validity only (``valid`` / ``invalid``).
- **Website / form**: HTTP GET, following at most 2 redirects; 200 → ``valid``; a 404 or a DNS
  failure → ``invalid``; anything else (timeout, other status, too many redirects) → ``unknown``.
"""
from __future__ import annotations

import socket
from typing import Any, Protocol

import phonenumbers

from kp.m01_platform import get_logger
from kp.m22_enrichment import DnsChecker

from .email_vendor import EmailVerifier
from .models import DeliverabilityStatus

_log = get_logger("kp.m25_freshness.checks")

HTTP_TIMEOUT_S = 6.0    # [tunable]
MAX_REDIRECTS = 2       # LLD M25: "within 2 redirects"
USER_AGENT = "ExportBuyersFreshnessBot/1.0 (+https://exportbuyers.example/bot)"


class UrlChecker(Protocol):
    def check(self, url: str) -> DeliverabilityStatus: ...


# ---- email ------------------------------------------------------------------------------------

def check_email(email: str, dns: DnsChecker, vendor: EmailVerifier) -> DeliverabilityStatus:
    """MX check, then the vendor (LLD: "Email: MX check, then the email-verification vendor")."""
    if "@" not in email:
        return "unknown"
    domain = email.rsplit("@", 1)[1].strip().lower()
    if not domain:
        return "unknown"
    mx = dns.mx_lookup(domain)
    if mx.has_mx is False:
        return "invalid"   # confirmed no MX: never worth a vendor call
    try:
        return vendor.verify(email)
    except Exception as e:  # noqa: BLE001 — a vendor crash must never negate a real contact
        _log.info("email vendor call raised", extra={"error": type(e).__name__})
        return "unknown"


# ---- phone / whatsapp ---------------------------------------------------------------------------

def check_phone(value: str, kind: str) -> DeliverabilityStatus:
    """LLD M25: "libphonenumber validity only (valid / invalid)". ``whatsapp`` values are stored as
    ``https://wa.me/<digits>`` (M22); the phone number is recovered from the tail of that URL."""
    e164 = value
    if kind == "whatsapp":
        digits = value.rsplit("/", 1)[-1].lstrip("+")
        e164 = "+" + digits
    try:
        n = phonenumbers.parse(e164, None)
    except phonenumbers.NumberParseException:
        return "invalid"   # unparseable is not a valid number either — LLD allows only valid/invalid
    return "valid" if phonenumbers.is_valid_number(n) else "invalid"


# ---- website / form -----------------------------------------------------------------------------

def _is_dns_failure(exc: BaseException) -> bool:
    cause = exc
    seen = 0
    while cause is not None and seen < 5:
        if isinstance(cause, socket.gaierror):
            return True
        cause = cause.__cause__ or cause.__context__
        seen += 1
    return False


def check_url(url: str, *, timeout_s: float = HTTP_TIMEOUT_S, transport: Any = None) -> DeliverabilityStatus:
    """LLD M25: "HTTP 200 within 2 redirects → valid; a 404 or DNS failure → invalid".

    ``transport`` lets tests inject an ``httpx.MockTransport`` instead of hitting the network.
    """
    import httpx

    try:
        with httpx.Client(follow_redirects=True, max_redirects=MAX_REDIRECTS, timeout=timeout_s,
                          transport=transport) as client:
            resp = client.get(url, headers={"User-Agent": USER_AGENT})
    except httpx.ConnectError as e:
        return "invalid" if _is_dns_failure(e) else "unknown"
    except httpx.TooManyRedirects:
        return "unknown"
    except httpx.HTTPError as e:
        _log.info("website/form reachability check failed", extra={"url": url, "error": type(e).__name__})
        return "unknown"
    if resp.status_code == 200:
        return "valid"
    if resp.status_code == 404:
        return "invalid"
    return "unknown"


__all__ = ["HTTP_TIMEOUT_S", "MAX_REDIRECTS", "UrlChecker", "check_email", "check_phone", "check_url"]
