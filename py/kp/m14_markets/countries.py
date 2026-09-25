"""Country codes for M14.

UN Comtrade identifies reporters and partners with UN M49 numeric codes (with a few Comtrade
specifics: 251 France, 579 Norway, 699 India, 757 Switzerland, 842 USA, 490 "Other Asia, nes"
= Taiwan). The product works in ISO 3166-1 alpha-2, so everything is mapped at ingest.
Partner codes that are areas / aggregates (no ISO code) are kept as ``M49:<code>``.
"""
from __future__ import annotations

import os

WORLD = "WLD"
INDIA = "IN"

# M49 (and Comtrade variants) → ISO 3166-1 alpha-2.
_M49_ISO2_TEXT = """
4 AF 8 AL 12 DZ 20 AD 24 AO 28 AG 31 AZ 32 AR 36 AU 40 AT 44 BS 48 BH 50 BD 51 AM 52 BB 56 BE 58 BE
60 BM 64 BT 68 BO 70 BA 72 BW 76 BR 84 BZ 90 SB 92 VG 96 BN 100 BG 104 MM 108 BI 112 BY 116 KH 120 CM
124 CA 132 CV 136 KY 140 CF 144 LK 148 TD 152 CL 156 CN 158 TW 170 CO 174 KM 178 CG 180 CD 184 CK
188 CR 191 HR 192 CU 196 CY 203 CZ 204 BJ 208 DK 212 DM 214 DO 218 EC 222 SV 226 GQ 231 ET 232 ER
233 EE 234 FO 242 FJ 246 FI 250 FR 251 FR 258 PF 262 DJ 266 GA 268 GE 270 GM 275 PS 276 DE 288 GH
292 GI 296 KI 300 GR 304 GL 308 GD 320 GT 324 GN 328 GY 332 HT 340 HN 344 HK 348 HU 352 IS 356 IN
360 ID 364 IR 368 IQ 372 IE 376 IL 380 IT 384 CI 388 JM 392 JP 398 KZ 400 JO 404 KE 408 KP 410 KR
414 KW 417 KG 418 LA 422 LB 426 LS 428 LV 430 LR 434 LY 440 LT 442 LU 446 MO 450 MG 454 MW 458 MY
462 MV 466 ML 470 MT 478 MR 480 MU 484 MX 490 TW 496 MN 498 MD 499 ME 500 MS 504 MA 508 MZ 512 OM
516 NA 520 NR 524 NP 528 NL 531 CW 533 AW 540 NC 548 VU 554 NZ 558 NI 562 NE 566 NG 578 NO 579 NO
583 FM 584 MH 585 PW 586 PK 591 PA 598 PG 600 PY 604 PE 608 PH 616 PL 620 PT 624 GW 626 TL 634 QA
642 RO 643 RU 646 RW 659 KN 662 LC 670 VC 674 SM 678 ST 682 SA 686 SN 688 RS 690 SC 694 SL 699 IN
702 SG 703 SK 704 VN 705 SI 706 SO 710 ZA 716 ZW 724 ES 728 SS 729 SD 740 SR 748 SZ 752 SE 756 CH
757 CH 760 SY 762 TJ 764 TH 768 TG 776 TO 780 TT 784 AE 788 TN 792 TR 795 TM 796 TC 798 TV 800 UG
804 UA 807 MK 818 EG 826 GB 834 TZ 840 US 842 US 854 BF 858 UY 860 UZ 862 VE 882 WS 887 YE 894 ZM
"""


def _parse_pairs(text: str) -> dict[int, str]:
    parts = text.split()
    if len(parts) % 2:
        raise ValueError("M49 table has an odd number of tokens")
    return {int(parts[i]): parts[i + 1] for i in range(0, len(parts), 2)}


M49_TO_ISO2: dict[int, str] = _parse_pairs(_M49_ISO2_TEXT)

# Reporter codes to query Comtrade with (Comtrade's own variants where it has them).
_PREFERRED_REPORTER_M49 = {"FR": 251, "NO": 579, "IN": 699, "CH": 757, "US": 842, "BE": 56, "TW": 490}
ISO2_TO_M49: dict[str, int] = {}
for _code, _iso in sorted(M49_TO_ISO2.items()):
    ISO2_TO_M49.setdefault(_iso, _code)
ISO2_TO_M49.update(_PREFERRED_REPORTER_M49)

# ~60 importing markets the Market Finder ranks [tunable; override with KP_M14_TARGET_COUNTRIES].
DEFAULT_TARGET_COUNTRIES: tuple[str, ...] = (
    "US", "CN", "DE", "GB", "FR", "JP", "NL", "IT", "KR", "CA", "MX", "ES", "BE", "AE", "SA", "SG", "HK", "MY",
    "TH", "VN", "ID", "PH", "AU", "NZ", "BD", "LK", "NP", "TR", "PL", "SE", "CH", "AT", "DK", "IE", "PT", "CZ",
    "RO", "GR", "IL", "EG", "ZA", "NG", "KE", "TZ", "GH", "MA", "BR", "AR", "CL", "CO", "PE", "RU", "KZ", "QA",
    "KW", "OM", "BH", "NO", "FI", "HU",
)


def target_countries() -> tuple[str, ...]:
    raw = os.environ.get("KP_M14_TARGET_COUNTRIES", "").strip()
    if not raw:
        return DEFAULT_TARGET_COUNTRIES
    out: list[str] = []
    for c in raw.replace(";", ",").split(","):
        c = c.strip().upper()
        if c and c not in out:
            if c not in ISO2_TO_M49:
                raise ValueError(f"KP_M14_TARGET_COUNTRIES: unknown country {c}")
            out.append(c)
    return tuple(out)


def partner_key(m49: int) -> str:
    """Partner column value: ISO2, 'WLD' for the world total, else 'M49:<code>'."""
    if m49 == 0:
        return WORLD
    iso = M49_TO_ISO2.get(m49)
    return iso if iso is not None else f"M49:{m49}"


def reporter_iso2(m49: int) -> str | None:
    return M49_TO_ISO2.get(m49)
