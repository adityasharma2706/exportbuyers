"""The maintained free-mail domain list (LLD M23: ``/config/freemail.txt``, refreshed monthly).

File format: one lower-case domain per line; ``#`` starts a comment. The file is reloaded when its
modification time changes, so a refresh by the monthly job (or a deploy) is picked up without a
restart. ``CORE_FREEMAIL`` is always included, so the check keeps working even if the file is
missing or an upstream refresh went wrong.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from kp.m01_platform import KpError, get_logger

_log = get_logger("kp.m23_registry.freemail")

SOURCE_FREEMAIL = "list.freemail"
# [tunable] upstream list (JSON array or one domain per line). Override with KP_FREEMAIL_UPSTREAM_URL.
DEFAULT_UPSTREAM_URL = "https://raw.githubusercontent.com/Kikobeats/free-email-domains/master/domains.json"
MIN_UPSTREAM_ENTRIES = 500      # [tunable] refuse an upstream list smaller than this
MAX_SHRINK_RATIO = 0.5          # [tunable] refuse an upstream list that would drop > 50 % of entries

CORE_FREEMAIL: frozenset[str] = frozenset({
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "yahoo.fr", "yahoo.de",
    "yahoo.es", "yahoo.it", "yahoo.com.br", "ymail.com", "rocketmail.com", "hotmail.com", "hotmail.co.uk",
    "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es", "outlook.com", "outlook.in", "live.com",
    "live.co.uk", "live.in", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "mail.com", "gmx.com",
    "gmx.de", "gmx.net", "web.de", "t-online.de", "freenet.de", "yandex.com", "yandex.ru", "mail.ru",
    "bk.ru", "list.ru", "inbox.ru", "rambler.ru", "protonmail.com", "proton.me", "pm.me", "tutanota.com",
    "zoho.com", "zohomail.com", "rediffmail.com", "qq.com", "163.com", "126.com", "sina.com", "sohu.com",
    "yeah.net", "naver.com", "daum.net", "hanmail.net", "libero.it", "virgilio.it", "tiscali.it",
    "orange.fr", "wanadoo.fr", "laposte.net", "free.fr", "sfr.fr", "seznam.cz", "wp.pl", "o2.pl",
    "interia.pl", "onet.pl", "btinternet.com", "sky.com", "talktalk.net", "comcast.net", "verizon.net",
    "att.net", "sbcglobal.net", "bellsouth.net", "cox.net", "earthlink.net", "juno.com", "shaw.ca",
    "rogers.com", "bigpond.com", "optusnet.com.au", "hushmail.com", "fastmail.com", "inbox.com", "usa.net",
    "bol.com.br", "uol.com.br", "terra.com.br", "ig.com.br", "yahoo.co.jp", "excite.com", "lycos.com",
})

_DOMAIN_RE = re.compile(r"^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$")


def default_path() -> Path:
    """<repo>/config/freemail.txt (py/kp/m23_registry/freemail.py → parents[3] is the repo root)."""
    env = os.environ.get("KP_FREEMAIL_PATH")
    return Path(env) if env else Path(__file__).resolve().parents[3] / "config" / "freemail.txt"


def parse_list(text: str) -> set[str]:
    """Domains from a JSON array or a one-per-line text list; invalid lines are skipped."""
    stripped = text.lstrip()
    items: Iterable[object]
    if stripped.startswith("["):
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError as e:
            raise KpError("VALIDATION", "free-mail list is not valid JSON") from e
        items = data if isinstance(data, list) else []
    else:
        items = (line.split("#", 1)[0] for line in text.splitlines())
    out: set[str] = set()
    for it in items:
        if not isinstance(it, str):
            continue
        d = it.strip().lower().rstrip(".")
        if d.startswith("@"):
            d = d[1:]
        if d and _DOMAIN_RE.match(d):
            out.add(d)
    return out


class FreemailList:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path
        self._domains: frozenset[str] = CORE_FREEMAIL
        self._mtime: float | None = None
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._path or default_path()

    def _maybe_reload(self) -> None:
        p = self.path
        try:
            mtime = p.stat().st_mtime
        except OSError:
            if self._mtime is not None:
                _log.warning("free-mail list file disappeared; using the built-in core list", extra={"path": str(p)})
            self._domains, self._mtime = CORE_FREEMAIL, None
            return
        if mtime == self._mtime:
            return
        try:
            loaded = parse_list(p.read_text(encoding="utf-8"))
        except (OSError, KpError, UnicodeDecodeError) as e:
            _log.warning("free-mail list unreadable; keeping the previous list",
                         extra={"path": str(p), "err": type(e).__name__})
            return
        self._domains = frozenset(loaded | CORE_FREEMAIL)
        self._mtime = mtime

    def domains(self) -> frozenset[str]:
        with self._lock:
            self._maybe_reload()
            return self._domains

    def contains(self, domain: str) -> bool:
        """True when ``domain`` or any parent of it is a free-mail domain (``mail.yahoo.co.uk`` too)."""
        d = (domain or "").strip().lower().rstrip(".")
        if d.startswith("www."):
            d = d[4:]
        doms = self.domains()
        labels = d.split(".")
        return any(".".join(labels[i:]) in doms for i in range(len(labels) - 1))

    def write(self, domains: set[str], upstream: str) -> int:
        """Atomically replaces the file with ``domains`` ∪ core. Returns the entry count."""
        merged = sorted(domains | CORE_FREEMAIL)
        p = self.path
        p.parent.mkdir(parents=True, exist_ok=True)
        header = (
            "# Free-mail domain list (M23). One domain per line; '#' starts a comment.\n"
            f"# Refreshed {datetime.now(timezone.utc).date().isoformat()} from {upstream}\n"
            "# Maintained by the m23.freemail_refresh job; edits are overwritten on the next refresh.\n"
        )
        fd, tmp = tempfile.mkstemp(prefix=".freemail.", dir=str(p.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(header)
                f.write("\n".join(merged))
                f.write("\n")
            os.replace(tmp, p)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        with self._lock:
            self._domains, self._mtime = frozenset(merged), None
        return len(merged)


_list = FreemailList()


def freemail_list() -> FreemailList:
    return _list


def set_freemail_list_for_testing(fl: FreemailList | None) -> None:
    global _list
    _list = fl or FreemailList()


def is_freemail(domain: str) -> bool:
    return _list.contains(domain)


def refresh_freemail(upstream_url: str | None = None) -> int:
    """Monthly refresh from the upstream list. Returns the new entry count.

    Raises ``KpError`` when the upstream cannot be fetched or fails the sanity checks; the current
    file is then left untouched.
    """
    from .vendor import VendorFailure, fetch_json, gate, require_source

    url = upstream_url or os.environ.get("KP_FREEMAIL_UPSTREAM_URL") or DEFAULT_UPSTREAM_URL
    try:
        require_source(SOURCE_FREEMAIL)
        gate(SOURCE_FREEMAIL, "freemail")
        r = fetch_json(SOURCE_FREEMAIL, url, follow_redirects=2) if url.endswith(".json") else None
        if r is not None:
            if not 200 <= r.status < 300:
                raise VendorFailure(SOURCE_FREEMAIL, "upstream_error", f"status {r.status}")
            body = r.raw.body.decode("utf-8", errors="replace")
        else:
            from kp.m08_sources import http_fetch

            resp = http_fetch(url)
            if not 200 <= resp.status < 300:
                raise VendorFailure(SOURCE_FREEMAIL, "upstream_error", f"status {resp.status}")
            body = resp.body.decode("utf-8", errors="replace")
    except VendorFailure as e:
        raise KpError("UPSTREAM_UNAVAILABLE", "free-mail list refresh failed",
                      {"reason": e.reason, "detail": e.detail}) from e
    domains = parse_list(body)
    current = len(_list.domains())
    if len(domains) < MIN_UPSTREAM_ENTRIES:
        raise KpError("UPSTREAM_UNAVAILABLE", "upstream free-mail list is implausibly small",
                      {"entries": len(domains), "min": MIN_UPSTREAM_ENTRIES})
    if current > MIN_UPSTREAM_ENTRIES and len(domains) < current * MAX_SHRINK_RATIO:
        raise KpError("UPSTREAM_UNAVAILABLE", "upstream free-mail list shrank too much",
                      {"entries": len(domains), "current": current})
    n = _list.write(domains, url)
    _log.info("free-mail list refreshed", extra={"entries": n, "upstream": url})
    return n
