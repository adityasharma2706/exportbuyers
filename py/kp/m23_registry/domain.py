"""Domain signals: registration age (RDAP, WHOIS fallback), MX and the free-mail flag.

- RDAP: the IANA bootstrap file (``data.iana.org/rdap/dns.json``) gives the RDAP base URL per TLD;
  the ``registration`` event is the creation date. Redirects are followed (some registries point
  to the registrar's RDAP server).
- WHOIS (port 43): used when the TLD has no RDAP service, or RDAP has no record. The server comes
  from ``whois.iana.org``'s ``refer:`` line, and the creation date is parsed from the common field
  names. WHOIS is best effort; ``age_days`` stays None when nothing parses.
- MX: our own dnspython lookup. ``has_mx`` is None when the resolver failed (never "no MX").

Sub-domains are handled without a public-suffix list: the lookup walks up one label at a time until
a registry answers (``shop.acme.co.uk`` → ``acme.co.uk``).
"""
from __future__ import annotations

import json
import re
import socket
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, Callable, Literal
from urllib.parse import urlsplit

from kp.m01_platform import KpError, get_logger
from kp.m08_sources import is_prohibited_host

from .cache import DOMAIN_TTL_S, default_cache
from .vendor import VendorFailure, expect_ok, fetch_json, gate, note_call, require_source

_log = get_logger("kp.m23_registry.domain")

SOURCE_RDAP = "domain.rdap"
SOURCE_WHOIS = "domain.whois"
SOURCE_DNS = "domain.dns"

RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json"
RDAP_FALLBACK_BASE = "https://rdap.org/"   # redirector, used when the bootstrap cannot be loaded
BOOTSTRAP_TTL_S = 24 * 3600                # in-process
BOOTSTRAP_CACHE_KEY = "m23:rdap:bootstrap"
WHOIS_IANA = "whois.iana.org"
WHOIS_TIMEOUT_S = 6.0
WHOIS_MAX_BYTES = 256 * 1024
DNS_LIFETIME_S = 5.0
MAX_PARENT_WALK = 3

# Second-level labels that are public suffixes under many ccTLDs (co.uk, com.au, …); never looked up
# on their own.
_GENERIC_SLDS = frozenset({"co", "com", "net", "org", "gov", "ac", "edu", "or", "ne", "go", "gob", "ltd", "plc",
                           "nic", "mil", "info", "biz", "gen", "firm", "ind", "res", "sch", "nom"})
_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


class InvalidDomain(KpError):
    def __init__(self, raw: str) -> None:
        super().__init__("VALIDATION", "Not a usable domain name", {"domain": raw[:255]})


def normalise_domain(raw: str) -> str:
    """Host from a domain, URL or e-mail address: lower-case, IDNA (punycode), no ``www.``."""
    s = (raw or "").strip()
    if "@" in s and "/" not in s:
        s = s.rsplit("@", 1)[1]
    if "://" in s:
        s = urlsplit(s).hostname or ""
    else:
        s = s.split("/", 1)[0].split(":", 1)[0]
    s = s.strip().rstrip(".").lower()
    if s.startswith("www."):
        s = s[4:]
    try:
        import idna

        s = idna.encode(s, uts46=True).decode("ascii") if s else s
    except Exception as e:  # noqa: BLE001 — any IDNA error means the input is not a domain
        raise InvalidDomain(raw) from e
    labels = s.split(".")
    if len(labels) < 2 or len(s) > 253 or not all(_LABEL_RE.match(lbl) for lbl in labels) or labels[-1].isdigit():
        raise InvalidDomain(raw)
    return s


def lookup_candidates(domain: str) -> list[str]:
    """The domain, then its parents, stopping before a bare public-suffix-like name."""
    labels = domain.split(".")
    out: list[str] = []
    for i in range(len(labels) - 1):
        cand = labels[i:]
        if len(cand) == 2 and i > 0 and cand[0] in _GENERIC_SLDS:
            break
        out.append(".".join(cand))
        if len(out) >= MAX_PARENT_WALK:
            break
    return out


def age_days_from(created: date, today: date | None = None) -> int:
    t = today or datetime.now(timezone.utc).date()
    return max(0, (t - created).days)


# ---- RDAP -----------------------------------------------------------------------------------

@dataclass(frozen=True)
class RegistrationLookup:
    outcome: Literal["found", "not_found", "no_service", "failed"]
    created: date | None = None
    name: str | None = None      # the registrable name the record belongs to
    detail: str | None = None
    via: Literal["rdap", "whois"] | None = None


class RdapBootstrap:
    """TLD → RDAP base URLs, from the IANA bootstrap file (cached in-process and in Redis)."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._map: dict[str, list[str]] | None = None
        self._loaded_at = 0.0
        self._lock = threading.Lock()

    @staticmethod
    def parse(body: Any) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        services = body.get("services") if isinstance(body, dict) else None
        for svc in services if isinstance(services, list) else []:
            if not isinstance(svc, list) or len(svc) < 2:
                continue
            tlds, urls = svc[0], svc[1]
            if not isinstance(tlds, list) or not isinstance(urls, list):
                continue
            https = [u for u in urls if isinstance(u, str) and u.startswith("https://")]
            bases = https or [u for u in urls if isinstance(u, str) and u.startswith("http")]
            for t in tlds:
                if isinstance(t, str) and bases:
                    out[t.lower()] = [b if b.endswith("/") else b + "/" for b in bases]
        return out

    def _load(self) -> dict[str, list[str]]:
        raw = default_cache().get(BOOTSTRAP_CACHE_KEY)
        if raw:
            try:
                m = self.parse(json.loads(raw))
                if m:
                    return m
            except (ValueError, TypeError):
                pass
        r = fetch_json(SOURCE_RDAP, RDAP_BOOTSTRAP_URL, follow_redirects=2)
        expect_ok(SOURCE_RDAP, r)
        m = self.parse(r.body)
        if not m:
            raise VendorFailure(SOURCE_RDAP, "upstream_error", "empty RDAP bootstrap")
        default_cache().set(BOOTSTRAP_CACHE_KEY, json.dumps(r.body, separators=(",", ":")), DOMAIN_TTL_S)
        return m

    def bases_for(self, domain: str) -> list[str] | None:
        """RDAP bases for the longest matching TLD entry; [] if the TLD has no RDAP service;
        None if the bootstrap itself could not be loaded."""
        with self._lock:
            if self._map is None or self._clock() - self._loaded_at > BOOTSTRAP_TTL_S:
                try:
                    self._map = self._load()
                    self._loaded_at = self._clock()
                except VendorFailure as e:
                    _log.warning("RDAP bootstrap unavailable", extra={"reason": e.reason, "detail": e.detail})
                    if self._map is None:
                        return None
            m = self._map
        labels = domain.split(".")
        for i in range(len(labels)):
            hit = m.get(".".join(labels[i:]))
            if hit:
                return hit
        return []

    def set_map_for_testing(self, m: dict[str, list[str]] | None) -> None:
        with self._lock:
            self._map = m
            self._loaded_at = self._clock() if m is not None else 0.0


_bootstrap = RdapBootstrap()


def rdap_bootstrap() -> RdapBootstrap:
    return _bootstrap


def _parse_date(v: Any) -> date | None:
    if not isinstance(v, str) or not v.strip():
        return None
    s = v.strip()
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except ValueError:
        pass
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def parse_rdap_created(body: Any) -> date | None:
    events = body.get("events") if isinstance(body, dict) else None
    best: date | None = None
    for ev in events if isinstance(events, list) else []:
        if not isinstance(ev, dict):
            continue
        if str(ev.get("eventAction") or "").lower() != "registration":
            continue
        d = _parse_date(ev.get("eventDate"))
        if d is not None and (best is None or d < best):
            best = d
    return best


def rdap_lookup(domain: str) -> RegistrationLookup:
    """Registration date via RDAP for ``domain`` or its nearest registered parent."""
    require_source(SOURCE_RDAP)
    bases = rdap_bootstrap().bases_for(domain)
    if bases == []:
        return RegistrationLookup("no_service")
    use = bases if bases else [RDAP_FALLBACK_BASE]
    last_detail = None
    for cand in lookup_candidates(domain):
        gate(SOURCE_RDAP, "rdap")
        try:
            r = fetch_json(SOURCE_RDAP, f"{use[0]}domain/{cand}", follow_redirects=3)
        finally:
            note_call("rdap", "domain")
        if r.status == 404:
            continue
        if r.status == 400:
            last_detail = "rdap 400"
            continue
        expect_ok(SOURCE_RDAP, r)
        created = parse_rdap_created(r.body)
        if created is None:
            return RegistrationLookup("found", None, cand, "no registration event", via="rdap")
        return RegistrationLookup("found", created, cand, via="rdap")
    return RegistrationLookup("not_found", detail=last_detail, via="rdap")


# ---- WHOIS ----------------------------------------------------------------------------------

WhoisTransport = Callable[[str, str, float], str]


def _socket_whois(server: str, query: str, timeout: float) -> str:
    if is_prohibited_host(server):
        raise VendorFailure(SOURCE_WHOIS, "robots", server)
    try:
        with socket.create_connection((server, 43), timeout=timeout) as s:
            s.settimeout(timeout)
            s.sendall((query + "\r\n").encode("ascii"))
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = s.recv(8192)
                if not chunk:
                    break
                total += len(chunk)
                if total > WHOIS_MAX_BYTES:
                    break
                chunks.append(chunk)
    except (OSError, UnicodeError) as e:
        raise VendorFailure(SOURCE_WHOIS, "upstream_error", f"{server}: {type(e).__name__}") from e
    return b"".join(chunks).decode("utf-8", errors="replace")


_whois_transport: WhoisTransport = _socket_whois


def set_whois_transport_for_testing(t: WhoisTransport | None) -> None:
    global _whois_transport
    _whois_transport = t or _socket_whois


_whois_servers: dict[str, str | None] = {}
_whois_lock = threading.Lock()

_REFER_RE = re.compile(r"(?im)^\s*(?:refer|whois)\s*:\s*([a-z0-9.-]+)\s*$")
_CREATED_RE = re.compile(
    r"(?im)^\s*(?:creation date|created on|created|domain registration date|registration date|"
    r"registered on|registration time|registered|domain record activated|record created on|"
    r"domain name commencement date|domain create date|first registration date)"
    r"\s*\.*\s*[:\]]\s*(.+?)\s*$"
)
_NOT_FOUND_RE = re.compile(r"(?i)\b(no match|not found|no entries found|no data found|status:\s*free|"
                           r"is available for registration|no object found|domain not found)\b")
_WHOIS_FORMATS = ("%Y-%m-%d", "%Y.%m.%d", "%Y/%m/%d", "%d-%b-%Y", "%d.%m.%Y", "%d/%m/%Y", "%Y%m%d",
                  "%d %b %Y", "%d %B %Y", "%B %d %Y", "%b %d %Y", "%Y-%m-%d %H:%M:%S", "%Y.%m.%d %H:%M:%S",
                  "%d-%b-%Y %H:%M:%S", "%a %b %d %H:%M:%S %Y")


def parse_whois_date(v: str) -> date | None:
    s = v.strip().rstrip(".")
    s = re.sub(r"\s*\((?:[^)]*)\)\s*$", "", s)           # trailing "(dd/mm/yyyy)" hints
    s = re.sub(r"\s+(?:UTC|GMT|[A-Z]{3,4}|[+-]\d{2}:?\d{2})$", "", s)
    d = _parse_date(s)
    if d is not None:
        return d
    for fmt in _WHOIS_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    first = s.split()[0] if s.split() else ""
    for fmt in _WHOIS_FORMATS[:8]:
        try:
            return datetime.strptime(first, fmt).date()
        except ValueError:
            continue
    return None


def parse_whois_created(text: str) -> date | None:
    for m in _CREATED_RE.finditer(text):
        d = parse_whois_date(m.group(1))
        if d is not None and date(1985, 1, 1) <= d <= datetime.now(timezone.utc).date():
            return d
    return None


def _whois_server(tld: str) -> str | None:
    with _whois_lock:
        if tld in _whois_servers:
            return _whois_servers[tld]
    gate(SOURCE_WHOIS, "whois")
    resp = _whois_transport(WHOIS_IANA, tld, WHOIS_TIMEOUT_S)
    note_call("whois", "iana_refer")
    m = _REFER_RE.search(resp)
    server = m.group(1).lower() if m else None
    with _whois_lock:
        _whois_servers[tld] = server
    return server


def whois_lookup(domain: str) -> RegistrationLookup:
    require_source(SOURCE_WHOIS)
    tld = domain.rsplit(".", 1)[-1]
    server = _whois_server(tld)
    if not server:
        return RegistrationLookup("no_service")
    for cand in lookup_candidates(domain):
        gate(SOURCE_WHOIS, "whois")
        resp = _whois_transport(server, cand, WHOIS_TIMEOUT_S)
        note_call("whois", "domain")
        created = parse_whois_created(resp)
        if created is not None:
            return RegistrationLookup("found", created, cand, via="whois")
        if _NOT_FOUND_RE.search(resp):
            continue
        if resp.strip():
            return RegistrationLookup("found", None, cand, "no parsable creation date", via="whois")
    return RegistrationLookup("not_found", via="whois")


def reset_whois_servers_for_testing() -> None:
    with _whois_lock:
        _whois_servers.clear()


# ---- MX -------------------------------------------------------------------------------------

MxLookup = Callable[[str], tuple[bool | None, tuple[str, ...]]]


def _dns_mx(domain: str) -> tuple[bool | None, tuple[str, ...]]:
    import dns.exception
    import dns.resolver

    r = dns.resolver.Resolver()
    r.lifetime = DNS_LIFETIME_S
    r.timeout = min(DNS_LIFETIME_S, 2.0)
    try:
        answer = r.resolve(domain, "MX")
    except dns.resolver.NXDOMAIN:
        return False, ()
    except dns.resolver.NoAnswer:
        return False, ()
    except dns.exception.DNSException as e:
        _log.info("MX lookup failed", extra={"domain": domain, "err": type(e).__name__})
        return None, ()
    hosts: list[tuple[int, str]] = []
    for rr in answer:
        host = str(rr.exchange).rstrip(".").lower()
        if host:  # RFC 7505 null MX "." means "accepts no mail"
            hosts.append((int(rr.preference), host))
    hosts.sort()
    return bool(hosts), tuple(h for _, h in hosts[:10])


_mx_lookup: MxLookup = _dns_mx


def set_mx_lookup_for_testing(fn: MxLookup | None) -> None:
    global _mx_lookup
    _mx_lookup = fn or _dns_mx


def mx_lookup(domain: str) -> tuple[bool | None, tuple[str, ...]]:
    try:
        require_source(SOURCE_DNS)
    except VendorFailure as e:
        _log.warning("DNS source not active; MX unknown", extra={"reason": e.reason})
        return None, ()
    return _mx_lookup(domain)


def registration_lookup(domain: str) -> tuple[RegistrationLookup, bool]:
    """RDAP first, WHOIS as fallback. Returns (lookup, rdap_available)."""
    rdap_available = False
    try:
        r = rdap_lookup(domain)
        if r.outcome == "found":
            rdap_available = True
            if r.created is not None:
                return r, True
    except VendorFailure as e:
        _log.info("RDAP lookup failed", extra={"domain": domain, "reason": e.reason, "detail": e.detail})
        r = RegistrationLookup("failed", detail=e.reason)
    try:
        w = whois_lookup(domain)
    except VendorFailure as e:
        _log.info("WHOIS lookup failed", extra={"domain": domain, "reason": e.reason, "detail": e.detail})
        w = RegistrationLookup("failed", detail=e.reason)
    if w.outcome == "found" and w.created is not None:
        return w, rdap_available
    # Prefer the more informative "no record" answer when neither gave a date.
    if r.outcome in ("found", "not_found"):
        return r, rdap_available
    return (w if w.outcome != "failed" else r), rdap_available
