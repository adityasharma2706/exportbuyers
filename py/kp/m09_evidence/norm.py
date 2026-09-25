"""Identifier normalisation, hashing and the suppression check used by M09.

The normalisation spec and the suppression list are owned by M10 (IF-10c: ``is_suppressed``,
``norm_hash``, ``any_suppressed``). M10 is built after M09, so this module provides:

- a fallback implementation of the M10 normalisation spec (see the module deviation notes: the
  Public Suffix List reduction and libphonenumber parsing are left to M10), and
- hooks (``set_norm_hash``, ``set_suppression_checker``) through which M10's Python client
  replaces both, so there is exactly one normaliser and one suppression source at run time.

Hash = ``sha256("<kind>:" + normalised)`` in lower-case hex (M10 spec).
"""
from __future__ import annotations

import hashlib
import re
import threading
import unicodedata
from typing import Any, Callable, Iterable, Literal

from kp.m01_platform import KpError, get_logger

IdentifierKind = Literal["domain", "email", "phone", "company_id", "registry"]
IDENTIFIER_KINDS: tuple[str, ...] = ("domain", "email", "phone", "company_id", "registry")

_log = get_logger("kp.m09_evidence.norm")
_GMAIL = frozenset({"gmail.com", "googlemail.com"})
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _norm_domain(raw: str) -> str:
    s = raw.strip().lower()
    if "://" in s:
        s = s.split("://", 1)[1]
    elif s.startswith("//"):
        s = s[2:]
    s = re.split(r"[/?#]", s, maxsplit=1)[0]
    if "@" in s:
        s = s.rsplit("@", 1)[1]
    if s.startswith("[") or s.count(":") == 1:
        s = s.split(":", 1)[0]
    s = s.rstrip(".")
    if s.startswith("www."):
        s = s[4:]
    labels = []
    for label in s.split("."):
        if not label:
            continue
        try:
            labels.append(label.encode("idna").decode("ascii"))
        except UnicodeError:
            labels.append(label)
    return ".".join(labels)


def _norm_email(raw: str) -> str:
    s = unicodedata.normalize("NFC", raw).strip().lower()
    if "@" not in s:
        return s
    local, domain = s.rsplit("@", 1)
    if domain in _GMAIL:
        local = local.split("+", 1)[0].replace(".", "")
    return f"{local}@{domain}"


def _norm_phone(raw: str) -> str:
    s = raw.strip()
    digits = re.sub(r"\D", "", s)
    if s.startswith("00") and 8 <= len(digits) - 2 <= 15:
        return "+" + digits[2:]
    if s.startswith("+") and 8 <= len(digits) <= 15:
        return "+" + digits
    return "raw:" + digits


def _norm_registry(raw: str) -> str:
    parts = raw.strip().split(":", 2)
    if len(parts) == 3:
        cc, reg, ident = parts
        return f"{cc.strip().upper()}:{reg.strip().lower()}:{re.sub(r'[^A-Za-z0-9]', '', ident).upper()}"
    return re.sub(r"[^A-Za-z0-9]", "", raw).upper()


def normalise(kind: str, raw: str) -> str:
    """Fallback normaliser following the M10 spec."""
    if not isinstance(raw, str):
        raise KpError("VALIDATION", f"cannot normalise a non-text {kind} identifier")
    if kind == "domain":
        return _norm_domain(raw)
    if kind == "email":
        return _norm_email(raw)
    if kind == "phone":
        return _norm_phone(raw)
    if kind == "company_id":
        s = raw.strip().lower()
        if not _UUID_RE.match(s):
            raise KpError("VALIDATION", "company_id identifiers must be uuids")
        return s
    if kind == "registry":
        return _norm_registry(raw)
    raise KpError("VALIDATION", f'Unknown identifier kind "{kind}"')


def _default_norm_hash(kind: str, raw: str) -> str:
    return hashlib.sha256(f"{kind}:{normalise(kind, raw)}".encode("utf-8")).hexdigest()


NormHash = Callable[[str, str], str]
SuppressionChecker = Callable[[list[str]], "set[str]"]

_lock = threading.Lock()
_norm_hash_impl: NormHash = _default_norm_hash
_suppression_checker: SuppressionChecker | None = None


def set_norm_hash(fn: NormHash | None) -> None:
    """Installs M10's ``norm_hash`` (``None`` restores the fallback)."""
    global _norm_hash_impl
    with _lock:
        _norm_hash_impl = fn or _default_norm_hash


def set_suppression_checker(fn: SuppressionChecker | None) -> None:
    """Installs M10's ``any_suppressed(hashes) -> set[str]``. When none is installed, M09 reads
    ``knowledge.suppression`` directly inside the caller's transaction (if the table exists)."""
    global _suppression_checker
    with _lock:
        _suppression_checker = fn


def installed_suppression_checker() -> SuppressionChecker | None:
    return _suppression_checker


def norm_hash(kind: str, raw: str) -> str:
    return _norm_hash_impl(kind, raw)


def contact_value_hash(kind: str, raw: str) -> str:
    """The ``value_hash`` stored in a ``contact.<kind>`` assertion and in ``contact_value``.

    Contacts that are identifiers hash with their identifier kind (so a suppressed email or
    phone matches); addresses, which are not identifiers, hash as ``address:<collapsed text>``.
    """
    if kind == "role_email":
        return norm_hash("email", raw)
    if kind in ("phone", "whatsapp"):
        digits_or_link = raw.strip()
        m = re.search(r"wa\.me/(\+?\d+)", digits_or_link)
        if m:
            digits_or_link = "+" + m.group(1).lstrip("+")
        return norm_hash("phone", digits_or_link)
    if kind in ("website", "form_url"):
        return norm_hash("domain", raw) if kind == "website" else hashlib.sha256(
            f"url:{raw.strip()}".encode("utf-8")).hexdigest()
    if kind == "address":
        collapsed = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", raw)).strip().lower()
        return hashlib.sha256(f"address:{collapsed}".encode("utf-8")).hexdigest()
    raise KpError("VALIDATION", f'Unknown contact kind "{kind}"')


def value_identifier_hashes(value: Any) -> list[str]:
    """Hashes of the identifiers carried in an assertion value (step 5 of write_assertion).

    Looks at ``value_hash`` (contacts: already hashed), ``domain``, ``url`` (its host),
    ``email`` and ``phone`` and ``registry_id``.
    """
    out: list[str] = []
    if not isinstance(value, dict):
        return out
    vh = value.get("value_hash")
    if isinstance(vh, str) and vh:
        out.append(vh)
    for key, kind in (("domain", "domain"), ("url", "domain"), ("email", "email"), ("phone", "phone"),
                      ("registry_id", "registry")):
        raw = value.get(key)
        if isinstance(raw, str) and raw.strip():
            try:
                out.append(norm_hash(kind, raw))
            except KpError:
                _log.warning("identifier could not be normalised", extra={"field": key})
    return out


def dedupe(hashes: Iterable[str]) -> list[str]:
    seen: dict[str, None] = {}
    for h in hashes:
        if h:
            seen.setdefault(h, None)
    return list(seen)
