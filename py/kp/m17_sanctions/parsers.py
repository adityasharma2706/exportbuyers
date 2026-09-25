"""Parsers for the five sanctions lists. Each returns ``(entries, publish_version)``, where the
version is the publisher's own date/stamp when the file carries one (else None; the ingest then
uses the file's sha256).

- OFAC SDN / consolidated (non-SDN): the classic ``SDN.XML`` / ``CONSOLIDATED.XML`` schema
  (``sdnList/sdnEntry``: uid, firstName, lastName, sdnType, akaList, addressList,
  nationalityList, citizenshipList; ``publshInformation/Publish_Date``).
- UN Security Council consolidated list XML (``CONSOLIDATED_LIST`` with ``INDIVIDUALS`` /
  ``ENTITIES``; DATAID, FIRST_NAME…FOURTH_NAME, NAME_ORIGINAL_SCRIPT, *_ALIAS/ALIAS_NAME,
  NATIONALITY/VALUE, *_ADDRESS/COUNTRY; ``@dateGenerated``).
- EU Financial Sanctions Files XML (``export/sanctionEntity@logicalId``, ``subjectType@code``,
  ``nameAlias@wholeName``, ``citizenship@countryIso2Code``, ``address@countryIso2Code``;
  ``@generationDate``).
- UK OFSI consolidated list CSV, 2022 format (a "Last Updated" line, then a header with Name 1–6,
  Name Non-Latin Script, Nationality, Country, Group Type and Group ID; one row per alias).

Namespaces are ignored. Countries are stored as ISO 3166-1 alpha-2 where they can be resolved.
"""
from __future__ import annotations

import csv
import io
import re
import xml.etree.ElementTree as ET
from functools import lru_cache
from typing import Any, Iterable, Iterator

import pycountry

from kp.m01_platform import KpError

from .models import ParsedEntry

MAX_NAMES_PER_ENTRY = 200
_WS = re.compile(r"\s+")

# Names the lists use that pycountry does not resolve on its own.
_COUNTRY_ALIASES: dict[str, str] = {
    "iran": "IR", "iran (islamic republic of)": "IR", "north korea": "KP", "korea, north": "KP",
    "democratic people's republic of korea": "KP", "dprk": "KP", "korea, south": "KR", "south korea": "KR",
    "republic of korea": "KR", "russia": "RU", "syria": "SY", "burma": "MM", "myanmar (burma)": "MM",
    "venezuela": "VE", "bolivia": "BO", "laos": "LA", "vietnam": "VN", "viet nam": "VN", "tanzania": "TZ",
    "moldova": "MD", "turkey": "TR", "turkiye": "TR", "türkiye": "TR", "czech republic": "CZ",
    "congo, democratic republic of the": "CD", "democratic republic of the congo": "CD", "drc": "CD",
    "congo, republic of the": "CG", "republic of the congo": "CG", "congo": "CG", "ivory coast": "CI",
    "cote d'ivoire": "CI", "côte d'ivoire": "CI", "palestinian": "PS", "palestine": "PS",
    "west bank": "PS", "gaza": "PS", "occupied palestinian territory": "PS", "kosovo": "XK",
    "the gambia": "GM", "gambia, the": "GM", "bahamas, the": "BS", "macedonia": "MK",
    "north macedonia": "MK", "swaziland": "SZ", "eswatini": "SZ", "cape verde": "CV", "taiwan": "TW",
    "hong kong": "HK", "macau": "MO", "macao": "MO", "brunei": "BN", "micronesia": "FM",
    "united kingdom": "GB", "uk": "GB", "great britain": "GB", "united states": "US", "usa": "US",
    "united states of america": "US", "uae": "AE", "united arab emirates": "AE", "crimea": "UA",
    "region: crimea": "UA", "vatican": "VA", "holy see": "VA", "east timor": "TL", "timor-leste": "TL",
    "saint kitts and nevis": "KN", "st. kitts and nevis": "KN", "saint lucia": "LC", "st. lucia": "LC",
    "saint vincent and the grenadines": "VC", "st. vincent and the grenadines": "VC",
}


@lru_cache(maxsize=4096)
def country_iso2(raw: str | None) -> str | None:
    """ISO 3166-1 alpha-2 for a country name or code as written in a list, or None."""
    if raw is None:
        return None
    s = _WS.sub(" ", str(raw)).strip().strip(".")
    if not s or s in ("00", "-", "?"):
        return None
    if len(s) == 2 and s.isalpha():
        code = s.upper()
        return code if code == "XK" or pycountry.countries.get(alpha_2=code) is not None else None
    low = s.lower()
    if low in _COUNTRY_ALIASES:
        return _COUNTRY_ALIASES[low]
    if len(s) == 3 and s.isalpha():
        c = pycountry.countries.get(alpha_3=s.upper())
        if c is not None:
            return str(c.alpha_2)
    try:
        c = pycountry.countries.lookup(s)
        return str(c.alpha_2)
    except LookupError:
        pass
    # "Iran, Islamic Republic of" style and "Country (details)" style
    base = re.sub(r"\s*\(.*\)\s*$", "", s)
    if base != s:
        return country_iso2(base)
    return None


def _clean(s: Any) -> str:
    return _WS.sub(" ", str(s)).strip() if s is not None else ""


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _children(el: ET.Element, name: str) -> Iterator[ET.Element]:
    for c in el:
        if _local(c.tag) == name:
            yield c


def _child(el: ET.Element, name: str) -> ET.Element | None:
    return next(_children(el, name), None)


def _text(el: ET.Element | None, name: str) -> str:
    if el is None:
        return ""
    c = _child(el, name)
    return _clean(c.text) if c is not None and c.text else ""


def _iter(el: ET.Element, name: str) -> Iterator[ET.Element]:
    for c in el.iter():
        if _local(c.tag) == name:
            yield c


def _parse_xml(body: bytes, what: str) -> ET.Element:
    if b"<!ENTITY" in body[:4096]:
        raise KpError("VALIDATION", f"{what}: XML entity declarations are not accepted")
    try:
        return ET.fromstring(body)
    except ET.ParseError as e:
        raise KpError("VALIDATION", f"{what}: file is not well-formed XML ({e})") from e


def _names(values: Iterable[str]) -> tuple[str, ...]:
    out: list[str] = []
    for v in values:
        c = _clean(v)
        if c and c not in out:
            out.append(c)
        if len(out) >= MAX_NAMES_PER_ENTRY:
            break
    return tuple(out)


def _countries(values: Iterable[str | None]) -> tuple[str, ...]:
    out: list[str] = []
    for v in values:
        c = country_iso2(v)
        if c and c not in out:
            out.append(c)
    return tuple(out)


# ---- OFAC -------------------------------------------------------------------------------------

_OFAC_TYPES = {"individual": "individual", "entity": "entity", "vessel": "vessel", "aircraft": "aircraft"}


def parse_ofac_xml(body: bytes, list_key: str) -> tuple[list[ParsedEntry], str | None]:
    if list_key not in ("ofac_sdn", "ofac_cons"):
        raise KpError("VALIDATION", f"parse_ofac_xml: unexpected list {list_key}")
    root = _parse_xml(body, "OFAC list")
    if _local(root.tag) != "sdnList":
        raise KpError("VALIDATION", f"OFAC list: unexpected root element {_local(root.tag)}")
    pub = _child(root, "publshInformation")
    version = _text(pub, "Publish_Date") or None
    out: list[ParsedEntry] = []
    for e in _children(root, "sdnEntry"):
        uid = _text(e, "uid")
        if not uid:
            continue
        names = [f"{_text(e, 'firstName')} {_text(e, 'lastName')}"]
        aka_list = _child(e, "akaList")
        if aka_list is not None:
            for aka in _children(aka_list, "aka"):
                names.append(f"{_text(aka, 'firstName')} {_text(aka, 'lastName')}")
        countries: list[str | None] = []
        for list_name, item_name in (("addressList", "address"), ("nationalityList", "nationality"),
                                     ("citizenshipList", "citizenship")):
            lst = _child(e, list_name)
            if lst is not None:
                countries.extend(_text(it, "country") for it in _children(lst, item_name))
        nm = _names(names)
        if not nm:
            continue
        etype = _OFAC_TYPES.get(_text(e, "sdnType").lower(), "unknown")
        out.append(ParsedEntry(list=list_key, list_uid=uid, names=nm, countries=_countries(countries),
                               entity_type=etype))
    return out, version


# ---- UN ---------------------------------------------------------------------------------------

def _un_entry(el: ET.Element, etype: str, alias_tag: str, address_tag: str) -> ParsedEntry | None:
    uid = _text(el, "DATAID") or _text(el, "REFERENCE_NUMBER")
    if not uid:
        return None
    full = " ".join(p for p in (_text(el, t) for t in ("FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME")) if p)
    names = [full, _text(el, "NAME_ORIGINAL_SCRIPT")]
    for a in _children(el, alias_tag):
        names.append(_text(a, "ALIAS_NAME"))
    countries: list[str | None] = []
    for a in _children(el, address_tag):
        countries.append(_text(a, "COUNTRY"))
    for nat in _children(el, "NATIONALITY"):
        countries.extend(_clean(v.text) for v in _children(nat, "VALUE") if v.text)
    nm = _names(names)
    if not nm:
        return None
    return ParsedEntry(list="un", list_uid=uid, names=nm, countries=_countries(countries), entity_type=etype)


def parse_un_xml(body: bytes) -> tuple[list[ParsedEntry], str | None]:
    root = _parse_xml(body, "UN list")
    if _local(root.tag) != "CONSOLIDATED_LIST":
        raise KpError("VALIDATION", f"UN list: unexpected root element {_local(root.tag)}")
    version = _clean(root.attrib.get("dateGenerated")) or None
    out: list[ParsedEntry] = []
    for ind in _iter(root, "INDIVIDUAL"):
        p = _un_entry(ind, "individual", "INDIVIDUAL_ALIAS", "INDIVIDUAL_ADDRESS")
        if p:
            out.append(p)
    for ent in _iter(root, "ENTITY"):
        p = _un_entry(ent, "entity", "ENTITY_ALIAS", "ENTITY_ADDRESS")
        if p:
            out.append(p)
    return out, version


# ---- EU ---------------------------------------------------------------------------------------

_EU_TYPES = {"person": "individual", "enterprise": "entity", "vessel": "vessel", "aircraft": "aircraft"}


def parse_eu_xml(body: bytes) -> tuple[list[ParsedEntry], str | None]:
    root = _parse_xml(body, "EU list")
    if _local(root.tag) != "export":
        raise KpError("VALIDATION", f"EU list: unexpected root element {_local(root.tag)}")
    version = _clean(root.attrib.get("generationDate")) or None
    out: list[ParsedEntry] = []
    for e in _children(root, "sanctionEntity"):
        uid = _clean(e.attrib.get("logicalId") or e.attrib.get("euReferenceNumber"))
        if not uid:
            continue
        st = _child(e, "subjectType")
        etype = _EU_TYPES.get(_clean(st.attrib.get("code") if st is not None else "").lower(), "unknown")
        names = [a.attrib.get("wholeName", "") for a in _children(e, "nameAlias")]
        countries: list[str | None] = []
        for tag in ("citizenship", "address"):
            for c in _children(e, tag):
                countries.append(c.attrib.get("countryIso2Code") or c.attrib.get("countryDescription"))
        nm = _names(names)
        if not nm:
            continue
        out.append(ParsedEntry(list="eu", list_uid=uid, names=nm, countries=_countries(countries), entity_type=etype))
    return out, version


# ---- UK OFSI ----------------------------------------------------------------------------------

_UK_TYPES = {"individual": "individual", "entity": "entity", "ship": "vessel"}


def parse_uk_ofsi_csv(body: bytes) -> tuple[list[ParsedEntry], str | None]:
    text = body.decode("utf-8-sig", errors="replace")
    rows = list(csv.reader(io.StringIO(text)))
    version: str | None = None
    header_at = -1
    for i, r in enumerate(rows[:10]):
        cells = [c.strip() for c in r]
        if cells and cells[0].lower() == "last updated" and len(cells) > 1:
            version = cells[1] or None
        if "Group ID" in cells and "Name 6" in cells:
            header_at = i
            break
    if header_at < 0:
        raise KpError("VALIDATION", "UK OFSI list: header row (Name 6 … Group ID) not found")
    header = [c.strip() for c in rows[header_at]]
    col = {h: i for i, h in enumerate(header)}

    def get(r: list[str], name: str) -> str:
        i = col.get(name)
        return _clean(r[i]) if i is not None and i < len(r) else ""

    groups: dict[str, dict[str, Any]] = {}
    for r in rows[header_at + 1:]:
        gid = get(r, "Group ID")
        if not gid:
            continue
        g = groups.setdefault(gid, {"names": [], "countries": [], "type": "unknown"})
        full = " ".join(p for p in (get(r, f"Name {k}") for k in (1, 2, 3, 4, 5, 6)) if p)
        g["names"].append(full)
        g["names"].append(get(r, "Name Non-Latin Script"))
        for field in ("Country", "Nationality"):
            v = get(r, field)
            # Nationality cells can hold several, e.g. "(1) Iran (2) Iraq".
            parts = [p for p in re.split(r"\(\d+\)|,\s*(?=[A-Z])|;", v) if p.strip()] if v else []
            g["countries"].extend(parts)
        gt = _UK_TYPES.get(get(r, "Group Type").lower())
        if gt:
            g["type"] = gt
    out: list[ParsedEntry] = []
    for gid, g in groups.items():
        nm = _names(g["names"])
        if nm:
            out.append(ParsedEntry(list="uk_ofsi", list_uid=gid, names=nm, countries=_countries(g["countries"]),
                                   entity_type=g["type"]))
    return out, version


def parse_list(list_key: str, body: bytes) -> tuple[list[ParsedEntry], str | None]:
    if list_key in ("ofac_sdn", "ofac_cons"):
        return parse_ofac_xml(body, list_key)
    if list_key == "un":
        return parse_un_xml(body)
    if list_key == "eu":
        return parse_eu_xml(body)
    if list_key == "uk_ofsi":
        return parse_uk_ofsi_csv(body)
    raise KpError("VALIDATION", f"Unknown sanctions list {list_key}")
