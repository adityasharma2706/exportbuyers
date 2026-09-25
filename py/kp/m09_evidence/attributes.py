"""M09 attribute vocabulary (LLD M09 "Attribute vocabulary").

Every assertion attribute must be on this allow-list. Each attribute has a value validator
and an *identity key* rule that decides which earlier assertion a new one supersedes:

- contacts (``contact.*``)                 → ``value.value_hash``
- evidence and aggregates                  → ``value.hs_heading``
- trust checks (``trust.check.<id>``)      → the check id
- ``not_buyer_for``                        → ``value.hs_heading`` (see deviation note in __init__)
- everything else is single-valued         → no key (one active assertion per subject+attribute)
"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Callable, Mapping

from kp.m01_platform import KpError

CONTACT_KINDS: tuple[str, ...] = ("website", "phone", "role_email", "form_url", "address", "whatsapp")
CONTACT_ATTRIBUTES: frozenset[str] = frozenset(f"contact.{k}" for k in CONTACT_KINDS)

FIXED_ATTRIBUTES: frozenset[str] = frozenset(
    {
        "product_evidence",
        "buyer_type",
        "activity_aggregate",
        *CONTACT_ATTRIBUTES,
        "registry.match",
        "domain.age_days",
        "domain.mx",
        "domain.freemail",
        "logistics_flag",
        "sanctions_flag",
        "trust.rollup",
        "status.closed",
        "not_buyer_for",
    }
)
TRUST_CHECK_PREFIX = "trust.check."
_TRUST_CHECK_RE = re.compile(r"^trust\.check\.([a-z0-9][a-z0-9_]{0,63})$")

HS_HEADING_RE = re.compile(r"^\d{4}$")
_VALUE_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_CC_RE = re.compile(r"^[A-Z]{2}$")

DELIVERABILITY: tuple[str, ...] = ("valid", "risky", "invalid", "unknown")
TRUST_OUTCOMES: tuple[str, ...] = ("pass", "fail", "unknown")
TRUST_LEVELS: tuple[str, ...] = ("high", "medium", "low", "unknown")

# Attributes keyed by HS heading (and so carried in the assertion.hs_heading column).
HEADING_KEYED: frozenset[str] = frozenset({"product_evidence", "activity_aggregate", "not_buyer_for"})


class InvalidAttribute(KpError):
    """The attribute is not on the allow-list, or its value does not match the vocabulary."""

    def __init__(self, attribute: str, reason: str = "not in the attribute allow-list") -> None:
        super().__init__("VALIDATION", f'Invalid assertion attribute "{attribute}": {reason}',
                         {"attribute": attribute, "reason": reason})
        self.attribute = attribute
        self.reason = reason


def is_allowed(attribute: str) -> bool:
    if not isinstance(attribute, str):
        return False
    return attribute in FIXED_ATTRIBUTES or bool(_TRUST_CHECK_RE.match(attribute))


def attribute_class(attribute: str) -> str:
    """The EV-01 attribute class: the prefix before the first '.'."""
    return attribute.split(".", 1)[0]


def is_contact(attribute: str) -> bool:
    return attribute in CONTACT_ATTRIBUTES


def contact_kind(attribute: str) -> str:
    return attribute.split(".", 1)[1]


# ---- value validators -------------------------------------------------------------------

def _need(value: Mapping[str, Any], key: str, attribute: str) -> Any:
    if key not in value or value[key] is None:
        raise InvalidAttribute(attribute, f"value.{key} is required")
    return value[key]


def _heading(value: Mapping[str, Any], attribute: str) -> None:
    h = _need(value, "hs_heading", attribute)
    if not isinstance(h, str) or not HS_HEADING_RE.match(h):
        raise InvalidAttribute(attribute, "value.hs_heading must be a 4-digit HS heading")


def _opt_str(value: Mapping[str, Any], key: str, attribute: str, max_len: int = 4000) -> None:
    v = value.get(key)
    if v is not None and (not isinstance(v, str) or len(v) > max_len):
        raise InvalidAttribute(attribute, f"value.{key} must be text of at most {max_len} characters")


def _nonneg_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0


def _iso_date(v: Any) -> bool:
    if isinstance(v, (date, datetime)):
        return True
    if not isinstance(v, str):
        return False
    try:
        date.fromisoformat(v[:10])
        return True
    except ValueError:
        return False


def _v_product_evidence(v: Mapping[str, Any], a: str) -> None:
    _heading(v, a)
    snippet = _need(v, "snippet", a)
    if not isinstance(snippet, str) or not snippet.strip() or len(snippet) > 2000:
        raise InvalidAttribute(a, "value.snippet must be 1..2000 characters")
    _opt_str(v, "url", a, 2048)


def _v_buyer_type(v: Mapping[str, Any], a: str) -> None:
    t = _need(v, "type", a)
    if not isinstance(t, str) or not re.match(r"^[a-z][a-z0-9_]{0,63}$", t):
        raise InvalidAttribute(a, "value.type must be a lower-case identifier")


def _v_activity(v: Mapping[str, Any], a: str) -> None:
    _heading(v, a)
    if not isinstance(_need(v, "shipments_12m", a), int) or isinstance(v["shipments_12m"], bool) \
            or v["shipments_12m"] < 0:
        raise InvalidAttribute(a, "value.shipments_12m must be a non-negative integer")
    vol = v.get("volume_kg_12m")
    if vol is not None and not _nonneg_number(vol):
        raise InvalidAttribute(a, "value.volume_kg_12m must be a non-negative number")
    origins = v.get("origins", {})
    if not isinstance(origins, Mapping) or not all(
        isinstance(k, str) and _CC_RE.match(k) and _nonneg_number(n) for k, n in origins.items()
    ):
        raise InvalidAttribute(a, "value.origins must map ISO country codes to counts")
    sup = v.get("top_suppliers", [])
    if not isinstance(sup, list):
        raise InvalidAttribute(a, "value.top_suppliers must be a list")
    last = v.get("last_seen")
    if last is not None and not _iso_date(last):
        raise InvalidAttribute(a, "value.last_seen must be an ISO date")


def _v_contact(v: Mapping[str, Any], a: str) -> None:
    h = _need(v, "value_hash", a)
    if not isinstance(h, str) or not _VALUE_HASH_RE.match(h):
        raise InvalidAttribute(a, "value.value_hash must be a lower-case sha256 hex digest")
    _opt_str(v, "display_mask", a, 256)
    d = v.get("deliverability")
    if d is not None and d not in DELIVERABILITY:
        raise InvalidAttribute(a, f"value.deliverability must be one of {', '.join(DELIVERABILITY)}")
    # Contact values never live in an assertion; they are kept only in contact_value.
    for forbidden in ("value", "raw", "email", "phone", "address"):
        if forbidden in v:
            raise InvalidAttribute(a, f"value.{forbidden} is not allowed; contact values live only in contact_value")


def _v_sanctions(v: Mapping[str, Any], a: str) -> None:
    if not isinstance(_need(v, "block", a), bool):
        raise InvalidAttribute(a, "value.block must be a boolean")


def _v_logistics(v: Mapping[str, Any], a: str) -> None:
    flag = v.get("is_logistics", True)
    if not isinstance(flag, bool):
        raise InvalidAttribute(a, "value.is_logistics must be a boolean")


def _v_trust_check(v: Mapping[str, Any], a: str) -> None:
    if _need(v, "outcome", a) not in TRUST_OUTCOMES:
        raise InvalidAttribute(a, f"value.outcome must be one of {', '.join(TRUST_OUTCOMES)}")


def _v_trust_rollup(v: Mapping[str, Any], a: str) -> None:
    if _need(v, "level", a) not in TRUST_LEVELS:
        raise InvalidAttribute(a, f"value.level must be one of {', '.join(TRUST_LEVELS)}")


def _v_domain_age(v: Mapping[str, Any], a: str) -> None:
    d = v.get("age_days")
    if d is not None and (not isinstance(d, int) or isinstance(d, bool) or d < 0):
        raise InvalidAttribute(a, "value.age_days must be null or a non-negative integer")


def _v_bool_key(key: str) -> Callable[[Mapping[str, Any], str], None]:
    def check(v: Mapping[str, Any], a: str) -> None:
        if key in v and not isinstance(v[key], bool):
            raise InvalidAttribute(a, f"value.{key} must be a boolean")
    return check


def _v_any(v: Mapping[str, Any], a: str) -> None:
    return None


_VALIDATORS: dict[str, Callable[[Mapping[str, Any], str], None]] = {
    "product_evidence": _v_product_evidence,
    "buyer_type": _v_buyer_type,
    "activity_aggregate": _v_activity,
    "registry.match": _v_any,
    "domain.age_days": _v_domain_age,
    "domain.mx": _v_bool_key("has_mx"),
    "domain.freemail": _v_bool_key("is_freemail"),
    "logistics_flag": _v_logistics,
    "sanctions_flag": _v_sanctions,
    "trust.rollup": _v_trust_rollup,
    "status.closed": _v_any,
    "not_buyer_for": lambda v, a: _heading(v, a),
    **{c: _v_contact for c in CONTACT_ATTRIBUTES},
}


def validate_value(attribute: str, value: Any, *, partial: bool = False) -> None:
    """Checks ``value`` against the vocabulary. ``partial`` (negation match) only checks the
    identity-key field, since a negative assertion names *which* fact is false."""
    if not is_allowed(attribute):
        raise InvalidAttribute(attribute)
    if not isinstance(value, Mapping):
        raise InvalidAttribute(attribute, "value must be a JSON object")
    if partial:
        key_field = identity_field(attribute)
        if key_field is not None:
            _need(value, key_field, attribute)
        return
    if attribute.startswith(TRUST_CHECK_PREFIX):
        _v_trust_check(value, attribute)
        return
    _VALIDATORS[attribute](value, attribute)


def identity_field(attribute: str) -> str | None:
    """The value field that forms the identity key, if any."""
    if is_contact(attribute):
        return "value_hash"
    if attribute in HEADING_KEYED:
        return "hs_heading"
    return None


def identity_key(attribute: str, value: Mapping[str, Any]) -> str | None:
    """Supersede identity key (LLD step 7). ``None`` means single-valued."""
    m = _TRUST_CHECK_RE.match(attribute)
    if m:
        return m.group(1)
    f = identity_field(attribute)
    if f is None:
        return None
    v = value.get(f)
    return None if v is None else str(v)


def hs_heading_of(attribute: str, value: Mapping[str, Any]) -> str | None:
    h = value.get("hs_heading")
    return h if isinstance(h, str) and HS_HEADING_RE.match(h) else None
