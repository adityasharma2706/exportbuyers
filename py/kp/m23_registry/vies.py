"""EU VIES VAT-number check (REST API, one GET per number)."""
from __future__ import annotations

import re
from typing import Any

from .models import VatResult, iso, utcnow
from .vendor import VendorFailure, expect_ok, fetch_json, gate, note_call, require_source, text

SOURCE_VIES = "registry.eu.vies"
VIES_API = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{cc}/vat/{number}"

# VIES member-state codes (EL = Greece, XI = Northern Ireland).
VIES_MEMBER_STATES: frozenset[str] = frozenset({
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT",
    "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI",
})
_ALIASES = {"GR": "EL"}
_VAT_RE = re.compile(r"^([A-Z]{2})([A-Z0-9+*]{2,14})$")
# userError values meaning "VIES could not answer now" rather than "the number is invalid".
_TRANSIENT = {"MS_UNAVAILABLE", "TIMEOUT", "SERVICE_UNAVAILABLE", "MS_MAX_CONCURRENT_REQ",
              "GLOBAL_MAX_CONCURRENT_REQ", "SERVER_BUSY", "IP_BLOCKED", "VAT_BLOCKED"}


def split_vat(vat: str) -> tuple[str, str] | None:
    """('DE', '123456789') from 'de 123.456.789'; None if it is not prefix + number."""
    s = re.sub(r"[\s.\-/]", "", (vat or "").upper())
    m = _VAT_RE.match(s)
    if not m:
        return None
    cc, number = m.group(1), m.group(2)
    return _ALIASES.get(cc, cc), number


def _vies_region(cc: str) -> str:
    return {"EL": "GR", "XI": "GB"}.get(cc, cc)


def parse_vies(cc: str, number: str, body: Any) -> VatResult:
    b = body if isinstance(body, dict) else {}
    user_error = str(b.get("userError") or "").upper()
    if user_error in _TRANSIENT:
        raise VendorFailure(SOURCE_VIES, "upstream_error", user_error)
    if user_error == "INVALID_INPUT":
        raise VendorFailure(SOURCE_VIES, "invalid_input", "VIES rejected the number format")
    if "isValid" not in b and "valid" not in b:
        raise VendorFailure(SOURCE_VIES, "upstream_error", "no validity in VIES response")
    valid = bool(b.get("isValid", b.get("valid")))
    name = text(b.get("name"))
    address = text(b.get("address"))
    # VIES shows '---' when a member state does not disclose the trader's details.
    name = None if name in ("---", "-") else name
    address = None if address in ("---", "-") else address
    return VatResult(
        vat=f"{cc}{number}", country_code=cc, number=number, valid=valid, checked_at=iso(utcnow()),
        source_id=SOURCE_VIES, name=name, address=address, request_date=text(b.get("requestDate")),
    )


def check_vies(cc: str, number: str) -> VatResult:
    if cc not in VIES_MEMBER_STATES:
        raise VendorFailure(SOURCE_VIES, "no_registry", cc)
    require_source(SOURCE_VIES, _vies_region(cc))
    gate(SOURCE_VIES, "vies")
    r = fetch_json(SOURCE_VIES, VIES_API.format(cc=cc, number=number))
    note_call("vies", "vat_check")
    expect_ok(SOURCE_VIES, r)
    return parse_vies(cc, number, r.body)
