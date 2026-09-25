"""M03 helpers: PII guard, stable hashing, JSON extraction and JSON-Schema (subset) validation.

Mirrors pii.ts and jsonSchema.ts on the TS side so both planes behave identically.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable

from kp.m01_platform import KpError

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_INTL_CANDIDATE_RE = re.compile(r"\+\s?\d[\d\s().-]{6,22}\d")
_PHONE_RES = (
    re.compile(r"(?<![\d.])(?:(?:\+?91)[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d.])"),
    re.compile(r"\(\d{2,5}\)\s?\d{3,4}[\s.-]?\d{4}(?!\d)"),
    re.compile(r"(?<![\d.])\d{3,5}[\s-]\d{3,4}[\s-]\d{4}(?![\d.])"),
)


def detect_pii(text: str) -> list[str]:
    """Kinds of personal-data patterns found (never the values)."""
    found: set[str] = set()
    if _EMAIL_RE.search(text):
        found.add("email")
    for m in _INTL_CANDIDATE_RE.finditer(text):
        digits = sum(ch.isdigit() for ch in m.group(0))
        if 8 <= digits <= 15:
            found.add("phone")
            break
    if "phone" not in found and any(r.search(text) for r in _PHONE_RES):
        found.add("phone")
    return sorted(found)


def assert_no_pii(purpose: str, texts: Iterable[str]) -> None:
    kinds: set[str] = set()
    for t in texts:
        kinds.update(detect_pii(t))
    if kinds:
        raise KpError(
            "VALIDATION",
            "LLM request marked pii_free contains an email or phone pattern",
            {"purpose": purpose, "kinds": sorted(kinds)},
        )


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------------------
# JSON extraction + schema validation
# --------------------------------------------------------------------------------------

_MAX_ERRORS = 10


def extract_json(text: str) -> tuple[bool, Any]:
    """Returns (True, value) or (False, error message)."""
    t = text.strip()
    candidates = [t]
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", t, re.IGNORECASE)
    if fence and fence.group(1):
        candidates.append(fence.group(1).strip())
    for open_c, close_c in (("{", "}"), ("[", "]")):
        a, b = t.find(open_c), t.rfind(close_c)
        if a >= 0 and b > a:
            candidates.append(t[a : b + 1])
    last = "empty response"
    for c in candidates:
        if not c:
            continue
        try:
            return True, json.loads(c)
        except json.JSONDecodeError as e:
            last = str(e)
    return False, f"response is not valid JSON ({last})"


def _type_of(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "integer" if v.is_integer() else "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def _matches_type(v: Any, t: str) -> bool:
    actual = _type_of(v)
    return actual in ("number", "integer") if t == "number" else actual == t


def _eq(a: Any, b: Any) -> bool:
    return _type_of(a) == _type_of(b) and a == b


def _validate(value: Any, schema: Any, path: str, errors: list[str]) -> None:
    if len(errors) >= _MAX_ERRORS or schema is True or schema is None:
        return
    if schema is False:
        errors.append(f"{path}: no value is allowed here")
        return
    if not isinstance(schema, dict):
        return
    s = schema
    if s.get("nullable") is True and value is None:
        return
    if "type" in s:
        types = [str(x) for x in s["type"]] if isinstance(s["type"], list) else [str(s["type"])]
        if not any(_matches_type(value, t) for t in types):
            errors.append(f"{path}: expected {' or '.join(types)}, got {_type_of(value)}")
            return
    if isinstance(s.get("enum"), list) and not any(_eq(e, value) for e in s["enum"]):
        errors.append(f"{path}: must be one of {json.dumps(s['enum'])}")
    if "const" in s and not _eq(s["const"], value):
        errors.append(f"{path}: must equal {json.dumps(s['const'])}")
    if isinstance(value, str):
        if isinstance(s.get("minLength"), int) and len(value) < s["minLength"]:
            errors.append(f"{path}: shorter than {s['minLength']}")
        if isinstance(s.get("maxLength"), int) and len(value) > s["maxLength"]:
            errors.append(f"{path}: longer than {s['maxLength']}")
        if isinstance(s.get("pattern"), str):
            try:
                if not re.search(s["pattern"], value):
                    errors.append(f"{path}: does not match pattern {s['pattern']}")
            except re.error:
                pass
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        for key, bad, msg in (
            ("minimum", lambda x, lim: x < lim, "less than"),
            ("maximum", lambda x, lim: x > lim, "greater than"),
            ("exclusiveMinimum", lambda x, lim: x <= lim, "must be greater than"),
            ("exclusiveMaximum", lambda x, lim: x >= lim, "must be less than"),
        ):
            lim = s.get(key)
            if isinstance(lim, (int, float)) and not isinstance(lim, bool) and bad(value, lim):
                errors.append(f"{path}: {msg} {lim}")
    if isinstance(value, list):
        if isinstance(s.get("minItems"), int) and len(value) < s["minItems"]:
            errors.append(f"{path}: fewer than {s['minItems']} items")
        if isinstance(s.get("maxItems"), int) and len(value) > s["maxItems"]:
            errors.append(f"{path}: more than {s['maxItems']} items")
        if "items" in s and not isinstance(s["items"], list):
            for i, item in enumerate(value):
                _validate(item, s["items"], f"{path}[{i}]", errors)
    if isinstance(value, dict):
        props = s.get("properties") if isinstance(s.get("properties"), dict) else {}
        for r in s.get("required") or []:
            if isinstance(r, str) and r not in value:
                errors.append(f'{path}: missing required property "{r}"')
        addl = s.get("additionalProperties")
        for k, v in value.items():
            if k in props:
                _validate(v, props[k], f"{path}.{k}", errors)
            elif addl is False:
                errors.append(f'{path}: unexpected property "{k}"')
            elif isinstance(addl, dict):
                _validate(v, addl, f"{path}.{k}", errors)
    for sub in s.get("allOf") or []:
        _validate(value, sub, path, errors)
    if isinstance(s.get("anyOf"), list):
        if not any(not _errs(value, sub, path) for sub in s["anyOf"]):
            errors.append(f"{path}: does not match any allowed schema (anyOf)")
    if isinstance(s.get("oneOf"), list):
        n = sum(1 for sub in s["oneOf"] if not _errs(value, sub, path))
        if n != 1:
            errors.append(f"{path}: must match exactly one schema (oneOf), matched {n}")


def _errs(value: Any, schema: Any, path: str) -> list[str]:
    e: list[str] = []
    _validate(value, schema, path, e)
    return e


def validate_json(value: Any, schema: dict[str, Any]) -> list[str]:
    return _errs(value, schema, "$")[:_MAX_ERRORS]


def parse_and_validate(text: str, schema: dict[str, Any]) -> tuple[bool, Any]:
    ok, val = extract_json(text)
    if not ok:
        return False, val
    errs = validate_json(val, schema)
    if errs:
        return False, "response does not match the JSON schema: " + "; ".join(errs)
    return True, val
