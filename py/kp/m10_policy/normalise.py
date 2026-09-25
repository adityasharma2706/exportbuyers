"""M10 identifier normalisation and hashing (IF-10c ``norm_hash``).

Mirrors ``apps/web/src/modules/m10_policy/normalise.ts``; both are checked against
``spec/normalisation/vectors.json``.

- ``domain``: lowercase; strip scheme, userinfo, path, port and a leading ``www.``; IDNA → punycode
  (UTS-46, non-transitional); registrable domain via the pinned Public Suffix List.
- ``email``: lowercase + trim (NFC); dots and ``+tags`` removed only for gmail.com / googlemail.com.
- ``phone``: E.164 via libphonenumber (``phonenumbers``); otherwise ``raw:`` + digits only.
- ``company_id``: the uuid (trimmed, lower-case).
- ``registry``: ``<CC>:<registry>:<ID upper-case, non-alphanumerics stripped>``.

Hash = ``sha256("<kind>:" + normalised)`` lower-case hex; no pepper.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata

import idna
import phonenumbers

from kp.m01_platform import KpError

from .psl import psl_rules, registrable_domain

IDENTIFIER_KINDS: tuple[str, ...] = ("domain", "email", "phone", "company_id", "registry")

_GMAIL = frozenset({"gmail.com", "googlemail.com"})
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def _require_text(kind: str, raw: object) -> str:
    if not isinstance(raw, str):
        raise KpError("VALIDATION", f"Cannot normalise a non-text {kind} identifier")
    s = raw.strip()
    if not s:
        raise KpError("VALIDATION", f"Empty {kind} identifier")
    return s


def _to_ascii_host(host: str) -> str:
    if host.isascii():
        return host
    try:
        return idna.encode(host, uts46=True, transitional=False).decode("ascii").lower()
    except idna.IDNAError:
        labels = []
        for label in host.split("."):
            try:
                labels.append(idna.encode(label, uts46=True, transitional=False).decode("ascii").lower())
            except idna.IDNAError:
                labels.append(label)
        return ".".join(labels)


def normalise_domain(raw: str) -> str:
    s = _require_text("domain", raw).lower()
    if "://" in s:
        s = s.split("://", 1)[1]
    elif s.startswith("//"):
        s = s[2:]
    s = re.split(r"[/?#]", s, maxsplit=1)[0]
    if "@" in s:
        s = s.rsplit("@", 1)[1]
    if s.startswith("["):
        end = s.find("]")
        return s[: end + 1] if end > 0 else s
    if s.count(":") == 1:
        s = s.split(":", 1)[0]
    s = s.rstrip(".")
    if s.startswith("www."):
        s = s[4:]
    s = ".".join(label for label in s.split(".") if label)
    if not s:
        raise KpError("VALIDATION", "Domain identifier has no host")
    if _IPV4_RE.match(s) or ":" in s:
        return s
    s = _to_ascii_host(s)
    return registrable_domain(psl_rules(), s)


def normalise_email(raw: str) -> str:
    s = unicodedata.normalize("NFC", _require_text("email", raw)).lower()
    if "@" not in s:
        return s
    local, domain = s.rsplit("@", 1)
    if domain in _GMAIL:
        local = local.split("+", 1)[0].replace(".", "")
    return f"{local}@{domain}"


def normalise_phone(raw: str) -> str:
    s = _require_text("phone", raw)
    if s.startswith("00"):
        s = "+" + s[2:]
    digits = re.sub(r"\D", "", s)
    if s.startswith("+"):
        try:
            pn = phonenumbers.parse(s, None)
            if phonenumbers.is_possible_number(pn):
                return phonenumbers.format_number(pn, phonenumbers.PhoneNumberFormat.E164)
        except phonenumbers.NumberParseException:
            pass
    return "raw:" + digits


def normalise_company_id(raw: str) -> str:
    s = _require_text("company_id", raw).lower()
    if not _UUID_RE.match(s):
        raise KpError("VALIDATION", "company_id identifiers must be uuids")
    return s


def normalise_registry(raw: str) -> str:
    s = _require_text("registry", raw)
    parts = s.split(":", 2)
    if len(parts) == 3:
        cc, reg, ident = parts
        return f"{cc.strip().upper()}:{reg.strip().lower()}:{re.sub(r'[^A-Za-z0-9]', '', ident).upper()}"
    return re.sub(r"[^A-Za-z0-9]", "", s).upper()


def normalise(kind: str, raw: str) -> str:
    if kind == "domain":
        return normalise_domain(raw)
    if kind == "email":
        return normalise_email(raw)
    if kind == "phone":
        return normalise_phone(raw)
    if kind == "company_id":
        return normalise_company_id(raw)
    if kind == "registry":
        return normalise_registry(raw)
    raise KpError("VALIDATION", f'Unknown identifier kind "{kind}"')


def hash_normalised(kind: str, normalised: str) -> str:
    return hashlib.sha256(f"{kind}:{normalised}".encode("utf-8")).hexdigest()


def norm_hash(kind: str, raw: str) -> str:
    """IF-10c: sha256("<kind>:" + normalise(kind, raw)) in lower-case hex."""
    if kind not in IDENTIFIER_KINDS:
        raise KpError("VALIDATION", f'Unknown identifier kind "{kind}"')
    return hash_normalised(kind, normalise(kind, raw))
