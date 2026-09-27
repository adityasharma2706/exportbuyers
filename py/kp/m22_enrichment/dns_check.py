"""M22 step 4 and the domain pre-check: our own DNS lookups (dnspython), no vendor.

- ``mx_lookup(domain)``   → ``MxResult(has_mx=True|False|None)``. ``False`` only on an authoritative
  answer (NXDOMAIN, no MX records, or an RFC 7505 null MX ``.``); ``None`` when the lookup itself
  failed, so a resolver outage never marks a mailbox ``invalid``.
- ``domain_resolves(domain)`` → ``True|False|None`` from A/AAAA; the crawl is skipped when ``False``.

Results are cached in-process for ``CACHE_TTL_S`` so one run does not ask twice.
"""
from __future__ import annotations

import threading
import time
from typing import Callable, Protocol

from kp.m01_platform import get_logger

from .models import MxResult

_log = get_logger("kp.m22_enrichment.dns")

LOOKUP_LIFETIME_S = 5.0     # [tunable]
CACHE_TTL_S = 3600.0


class DnsChecker(Protocol):
    def mx_lookup(self, domain: str) -> MxResult: ...
    def domain_resolves(self, domain: str) -> bool | None: ...


class DnsPythonChecker:
    """The production checker, backed by dnspython's stub resolver."""

    def __init__(self, lifetime: float = LOOKUP_LIFETIME_S, clock: Callable[[], float] = time.monotonic) -> None:
        self._lifetime = lifetime
        self._clock = clock
        self._mx: dict[str, tuple[float, MxResult]] = {}
        self._a: dict[str, tuple[float, bool | None]] = {}
        self._lock = threading.Lock()

    def _resolver(self):  # type: ignore[no-untyped-def]
        import dns.resolver

        r = dns.resolver.Resolver()
        r.lifetime = self._lifetime
        r.timeout = min(self._lifetime, 2.0)
        return r

    def mx_lookup(self, domain: str) -> MxResult:
        d = domain.strip().lower().rstrip(".")
        now = self._clock()
        with self._lock:
            hit = self._mx.get(d)
            if hit and now - hit[0] < CACHE_TTL_S:
                return hit[1]
        res = self._mx_uncached(d)
        if res.has_mx is not None:
            with self._lock:
                self._mx[d] = (now, res)
        return res

    def _mx_uncached(self, d: str) -> MxResult:
        import dns.exception
        import dns.resolver

        try:
            answer = self._resolver().resolve(d, "MX")
        except dns.resolver.NXDOMAIN:
            return MxResult(domain=d, has_mx=False, error="nxdomain")
        except dns.resolver.NoAnswer:
            return MxResult(domain=d, has_mx=False, error="no_mx")
        except (dns.resolver.NoNameservers, dns.exception.Timeout) as e:
            _log.info("MX lookup failed", extra={"domain": d, "err": type(e).__name__})
            return MxResult(domain=d, has_mx=None, error=type(e).__name__)
        except dns.exception.DNSException as e:
            _log.info("MX lookup failed", extra={"domain": d, "err": type(e).__name__})
            return MxResult(domain=d, has_mx=None, error=type(e).__name__)
        hosts: list[tuple[int, str]] = []
        for rr in answer:
            host = str(rr.exchange).rstrip(".").lower()
            if host:  # RFC 7505 null MX is exchange "." → empty after strip
                hosts.append((int(rr.preference), host))
        hosts.sort()
        return MxResult(domain=d, has_mx=bool(hosts), hosts=tuple(h for _, h in hosts),
                        error=None if hosts else "null_mx")

    def domain_resolves(self, domain: str) -> bool | None:
        import dns.exception
        import dns.resolver

        d = domain.strip().lower().rstrip(".")
        now = self._clock()
        with self._lock:
            hit = self._a.get(d)
            if hit and now - hit[0] < CACHE_TTL_S:
                return hit[1]
        result: bool | None = None
        nx = 0
        for rtype in ("A", "AAAA"):
            try:
                self._resolver().resolve(d, rtype)
                result = True
                break
            except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
                nx += 1
            except dns.exception.DNSException as e:
                _log.info("address lookup failed", extra={"domain": d, "rtype": rtype, "err": type(e).__name__})
        if result is None and nx == 2:
            result = False
        if result is not None:
            with self._lock:
                self._a[d] = (now, result)
        return result


_default: DnsChecker | None = None
_default_lock = threading.Lock()


def default_dns_checker() -> DnsChecker:
    global _default
    with _default_lock:
        if _default is None:
            _default = DnsPythonChecker()
        return _default


def set_dns_checker_for_testing(checker: DnsChecker | None) -> None:
    global _default
    with _default_lock:
        _default = checker
