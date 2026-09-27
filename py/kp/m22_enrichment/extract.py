"""M22 step 3: deterministic contact extraction from the company's own pages (no LLM).

From each page's HTML:

- **Role emails** matching ``^(info|sales|export|import|purchasing|procurement|buying|contact|office|
  enquiries)@`` on the company domain (``mailto:`` links, JSON-LD, visible text). Every other mailbox
  on the company domain looks personal (``firstname.lastname@``) and is discarded and only counted;
  mailboxes on other domains are ignored. REQ-035 (named people) is not built.
- **Phones** from ``tel:`` links, JSON-LD ``telephone`` and visible text via libphonenumber
  (``phonenumbers``) with the company's country as the default region; stored as E.164. Numbers
  labelled "fax" are skipped.
- **Address** from schema.org ``PostalAddress`` (JSON-LD or microdata), else an ``<address>`` block.
- **Contact-form URLs**: a page holding a ``<form>`` with a message ``<textarea>`` that is neither a
  search nor a login form.
- **WhatsApp**: ``wa.me`` / ``api.whatsapp.com/send?phone=`` links → ``contact.whatsapp``.
"""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from typing import Any, Iterable, Iterator
from urllib.parse import parse_qs, unquote, urldefrag, urljoin, urlsplit

import phonenumbers

from kp.m01_platform import get_logger
from kp.m18_resolution import normalise_domain
from kp.m20_discovery import html_to_text

from .models import (
    MAX_ADDRESS_CHARS,
    MAX_EMAILS,
    MAX_FORMS,
    MAX_PHONES,
    MAX_WHATSAPP,
    ROLE_EMAIL_RE,
    ContactCandidate,
    ContactPage,
)

_log = get_logger("kp.m22_enrichment.extract")

_EMAIL_RE = re.compile(r"(?<![\w.%+-])([A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?"
                       r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*\.[A-Za-z]{2,24})")
# "info [at] acme [dot] de", "sales(at)acme.de"
_AT_OBF = re.compile(r"\s*[\[(]\s*at\s*[\])]\s*", re.IGNORECASE)
_DOT_OBF = re.compile(r"\s*[\[(]\s*dot\s*[\])]\s*", re.IGNORECASE)
_WA_ME = re.compile(r"^(?:https?://)?(?:www\.)?wa\.me/\+?(\d{6,15})(?:[/?#]|$)", re.IGNORECASE)
_WA_API = re.compile(r"^(?:https?://)?(?:api|web)\.whatsapp\.com/send/?\?", re.IGNORECASE)
_WA_SCHEME = re.compile(r"^whatsapp://send/?\?", re.IGNORECASE)
_WS = re.compile(r"\s+")
_FAX_NEAR = re.compile(r"fax|telefax", re.IGNORECASE)
_ADDR_SKIP_LINE = re.compile(r"@|https?://|\b(tel|phone|fax|telefon|e-?mail|mobile|whatsapp)\b", re.IGNORECASE)
_ADDR_PROPS = ("streetAddress", "postalCode", "addressLocality", "addressRegion", "addressCountry")
_BLOCK = frozenset({"p", "div", "br", "li", "tr", "td", "h1", "h2", "h3", "h4", "h5", "h6", "section"})
_CONF = {"mailto": 0.9, "jsonld": 0.85, "microdata": 0.85, "text": 0.7, "tel_link": 0.9, "address_tag": 0.7,
         "form": 0.8, "wa_link": 0.85, "homepage": 1.0}


# ---- HTML walk ---------------------------------------------------------------------------------

class _FormState:
    __slots__ = ("has_textarea", "has_password", "is_search", "action")

    def __init__(self, role: str, action: str) -> None:
        self.has_textarea = False
        self.has_password = False
        self.is_search = role == "search" or "search" in action.lower()
        self.action = action


class _Walker(HTMLParser):
    """Collects hrefs, JSON-LD blocks, <address> text, microdata address parts and form shapes."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hrefs: list[str] = []
        self.jsonld: list[str] = []
        self.address_blocks: list[str] = []
        self.microdata: dict[str, str] = {}
        self.contact_forms = 0
        self._in_jsonld = False
        self._jsonld_buf: list[str] = []
        self._addr_depth = 0
        self._addr_buf: list[str] = []
        self._captures: list[tuple[str, str, list[str]]] = []   # (tag, itemprop, text parts)
        self._form: _FormState | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "a" and a.get("href"):
            self.hrefs.append(a["href"])
        elif tag == "script" and a.get("type", "").lower().strip() == "application/ld+json":
            self._in_jsonld = True
            self._jsonld_buf = []
        elif tag == "address":
            self._addr_depth += 1
            if self._addr_depth == 1:
                self._addr_buf = []
        elif tag == "form":
            self._form = _FormState(a.get("role", "").lower(), a.get("action", ""))
        elif tag == "textarea" and self._form is not None:
            self._form.has_textarea = True
        elif tag == "input" and self._form is not None:
            t = a.get("type", "text").lower()
            if t == "password":
                self._form.has_password = True
            elif t == "search":
                self._form.is_search = True
        prop = a.get("itemprop", "")
        if prop in _ADDR_PROPS:
            content = a.get("content", "").strip()
            if content:
                self.microdata.setdefault(prop, content[:200])
            elif tag not in ("meta", "link", "br", "img", "input"):
                self._captures.append((tag, prop, []))
        if self._addr_depth and tag in _BLOCK:
            self._addr_buf.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._in_jsonld:
            self._in_jsonld = False
            self.jsonld.append("".join(self._jsonld_buf))
        elif tag == "address" and self._addr_depth:
            self._addr_depth -= 1
            if self._addr_depth == 0:
                self.address_blocks.append("".join(self._addr_buf))
        elif tag == "form" and self._form is not None:
            f = self._form
            if f.has_textarea and not f.has_password and not f.is_search:
                self.contact_forms += 1
            self._form = None
        if self._addr_depth and tag in _BLOCK:
            self._addr_buf.append("\n")
        for i in range(len(self._captures) - 1, -1, -1):
            ctag, prop, parts = self._captures[i]
            if ctag == tag:
                text = _WS.sub(" ", "".join(parts)).strip()
                if text:
                    self.microdata.setdefault(prop, text[:200])
                del self._captures[i]
                break

    def handle_data(self, data: str) -> None:
        if self._in_jsonld:
            self._jsonld_buf.append(data)
            return
        if self._addr_depth:
            self._addr_buf.append(data)
        for _tag, _prop, parts in self._captures:
            parts.append(data)


def _walk(html: str) -> _Walker:
    w = _Walker()
    try:
        w.feed(html)
        w.close()
    except Exception:  # noqa: BLE001 — malformed HTML: keep what was parsed
        _log.info("html walk stopped early")
    return w


# ---- JSON-LD -----------------------------------------------------------------------------------

def _jsonld_nodes(blocks: Iterable[str]) -> Iterator[dict[str, Any]]:
    def visit(node: Any, depth: int) -> Iterator[dict[str, Any]]:
        if depth > 8:
            return
        if isinstance(node, dict):
            yield node
            for v in node.values():
                yield from visit(v, depth + 1)
        elif isinstance(node, list):
            for v in node[:200]:
                yield from visit(v, depth + 1)

    for raw in blocks:
        try:
            data = json.loads(raw.strip())
        except (ValueError, TypeError):
            continue
        yield from visit(data, 0)


def _postal_to_text(node: Any) -> str | None:
    if isinstance(node, str):
        s = _WS.sub(" ", node).strip()
        return s or None
    if not isinstance(node, dict):
        return None
    parts: list[str] = []
    for key in _ADDR_PROPS:
        v = node.get(key)
        if isinstance(v, dict):
            v = v.get("name")
        if isinstance(v, str) and v.strip():
            parts.append(_WS.sub(" ", v).strip())
    return ", ".join(parts) or None


# ---- helpers -----------------------------------------------------------------------------------

def _host_matches(host: str, domain: str) -> bool:
    h = host.strip().lower().rstrip(".")
    if h == domain or h.endswith("." + domain):
        return True
    return normalise_domain(h) == domain


def classify_email(raw: str, domain: str) -> str | None:
    """``'role'`` (keep), ``'personal'`` (discard, counted), or ``None`` (not on the company domain)."""
    email = raw.strip().strip(".,;:").lower()
    if "@" not in email:
        return None
    host = email.rsplit("@", 1)[1]
    if not _host_matches(host, domain):
        return None
    return "role" if ROLE_EMAIL_RE.match(email) else "personal"


def _phone_e164(raw: str, region: str | None) -> str | None:
    s = unquote(raw).strip()
    if not s:
        return None
    try:
        n = phonenumbers.parse(s, region if region else None)
    except phonenumbers.NumberParseException:
        return None
    if not phonenumbers.is_valid_number(n):
        return None
    return phonenumbers.format_number(n, phonenumbers.PhoneNumberFormat.E164)


def whatsapp_link(href: str) -> str | None:
    """``https://wa.me/<digits>`` for a WhatsApp click-to-chat link with a valid number, else None."""
    h = href.strip()
    digits: str | None = None
    m = _WA_ME.match(h)
    if m:
        digits = m.group(1)
    elif _WA_API.match(h) or _WA_SCHEME.match(h):
        q = parse_qs(h.split("?", 1)[1]) if "?" in h else {}
        phone = (q.get("phone") or [""])[0]
        digits = re.sub(r"\D", "", phone) or None
    if not digits or not 6 <= len(digits) <= 15:
        return None
    e164 = _phone_e164("+" + digits, None)
    return f"https://wa.me/{e164[1:]}" if e164 else None


def _clean_address(block: str) -> str | None:
    lines = []
    for ln in block.split("\n"):
        ln = _WS.sub(" ", ln).strip(" ,;|")
        if not ln or _ADDR_SKIP_LINE.search(ln):
            continue
        lines.append(ln)
    text = ", ".join(dict.fromkeys(lines))
    if not 10 <= len(text) <= MAX_ADDRESS_CHARS or not re.search(r"\d", text):
        return None
    return text


def _deobfuscate(text: str) -> str:
    return _DOT_OBF.sub(".", _AT_OBF.sub("@", text))


# ---- per page ----------------------------------------------------------------------------------

class PageExtraction:
    def __init__(self) -> None:
        self.candidates: list[ContactCandidate] = []
        self.personal_emails: set[str] = set()


def extract_page(page: ContactPage, domain: str, region: str | None) -> PageExtraction:
    """Contact candidates found on one page (not yet deduplicated across pages)."""
    out = PageExtraction()
    w = _walk(page.html)
    text, _title, _site, _links = html_to_text(page.html)

    def add(kind: str, value: str, method: str) -> None:
        out.candidates.append(ContactCandidate(
            kind=kind, value=value, url=page.url, captured_at=page.fetched_at,  # type: ignore[arg-type]
            raw_object_id=page.raw_object_id, method=method, confidence=_CONF[method]))

    def email(raw: str, method: str) -> None:
        e = raw.strip().strip(".,;:").lower()
        verdict = classify_email(e, domain)
        if verdict == "role":
            add("role_email", e, method)
        elif verdict == "personal":
            out.personal_emails.add(e)

    # links: mailto, tel, WhatsApp
    for href in w.hrefs:
        h = href.strip()
        low = h.lower()
        if low.startswith("mailto:"):
            addr = unquote(h[7:].split("?", 1)[0])
            for part in addr.split(","):
                if _EMAIL_RE.fullmatch(part.strip()):
                    email(part, "mailto")
        elif low.startswith(("tel:", "callto:")):
            e164 = _phone_e164(h.split(":", 1)[1], region)
            if e164:
                add("phone", e164, "tel_link")
        else:
            wa = whatsapp_link(h)
            if wa:
                add("whatsapp", wa, "wa_link")

    # JSON-LD: email, telephone, address
    jsonld_address: str | None = None
    for node in _jsonld_nodes(w.jsonld):
        em = node.get("email")
        if isinstance(em, str):
            em = em[7:] if em.lower().startswith("mailto:") else em
            if _EMAIL_RE.fullmatch(em.strip()):
                email(em, "jsonld")
        tel = node.get("telephone")
        if isinstance(tel, str):
            e164 = _phone_e164(tel, region)
            if e164:
                add("phone", e164, "jsonld")
        addr = node.get("address")
        typ = node.get("@type")
        if addr is None and (typ == "PostalAddress" or (isinstance(typ, list) and "PostalAddress" in typ)):
            addr = node
        if jsonld_address is None and addr is not None:
            if isinstance(addr, list):
                addr = addr[0] if addr else None
            t = _postal_to_text(addr)
            if t and 10 <= len(t) <= MAX_ADDRESS_CHARS:
                jsonld_address = t

    # Address: JSON-LD, then microdata, then <address>
    if jsonld_address:
        add("address", jsonld_address, "jsonld")
    else:
        md = ", ".join(w.microdata[p] for p in _ADDR_PROPS if p in w.microdata)
        if w.microdata.get("streetAddress") and 10 <= len(md) <= MAX_ADDRESS_CHARS:
            add("address", md, "microdata")
        else:
            for block in w.address_blocks:
                cleaned = _clean_address(block)
                if cleaned:
                    add("address", cleaned, "address_tag")
                    break

    # Visible text: emails (including "[at]" obfuscation) and phone numbers
    for m in _EMAIL_RE.finditer(_deobfuscate(text)):
        email(m.group(1), "text")
    if region:
        try:
            matcher = phonenumbers.PhoneNumberMatcher(text, region, leniency=phonenumbers.Leniency.VALID,
                                                      max_tries=200)
            found = 0
            for match in matcher:
                if _FAX_NEAR.search(text[max(0, match.start - 16):match.start]):
                    continue
                add("phone", phonenumbers.format_number(match.number, phonenumbers.PhoneNumberFormat.E164), "text")
                found += 1
                if found >= MAX_PHONES:
                    break
        except Exception:  # noqa: BLE001 — a matcher failure only loses text phones for this page
            _log.info("phone matcher failed", extra={"url": page.url})

    # Contact forms: the page itself is the form URL
    if w.contact_forms:
        add("form_url", urldefrag(page.url)[0], "form")
    return out


def extract_contacts(pages: list[ContactPage], domain: str, region: str | None) -> tuple[list[ContactCandidate], int]:
    """All pages → deduplicated candidates (best-confidence occurrence kept, then capped per kind)
    and the number of distinct personal-looking mailboxes that were discarded."""
    best: dict[tuple[str, str], ContactCandidate] = {}
    order: list[tuple[str, str]] = []
    personal: set[str] = set()
    for page in pages:
        ex = extract_page(page, domain, region)
        personal |= ex.personal_emails
        for c in ex.candidates:
            k = c.dedupe_key()
            if k not in best:
                order.append(k)
                best[k] = c
            elif c.confidence > best[k].confidence:
                best[k] = c
    caps = {"role_email": MAX_EMAILS, "phone": MAX_PHONES, "form_url": MAX_FORMS, "whatsapp": MAX_WHATSAPP,
            "address": 1}
    counts: dict[str, int] = {}
    out: list[ContactCandidate] = []
    for k in sorted(order, key=lambda key: -best[key].confidence):
        c = best[k]
        if counts.get(c.kind, 0) >= caps.get(c.kind, 1):
            continue
        counts[c.kind] = counts.get(c.kind, 0) + 1
        out.append(c)
    return out, len(personal)


def same_site_url(url: str, domain: str) -> bool:
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return False
    return bool(host) and _host_matches(host or "", domain)


def absolute(base: str, href: str) -> str:
    return urldefrag(urljoin(base, href))[0]
