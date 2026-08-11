"""Conversion rules for backfilling Xano cash_sales into Supabase.

The two stacks disagree about how a sale is written down, and both differences
are the silent kind: they import fine and then produce wrong numbers.

  amount   Xano stores dollars as TEXT ("40", "64.20"). Supabase stores integer
           cents (4000, 6420). Copying the value straight across makes every
           cash sale 100x too small.
  type     Xano has four spellings across its history: "cash", "Cash", "card",
           and null. Supabase matches type = 'cash' exactly, so anything else
           imports and then counts toward nothing.
  kiosk    Xano holds Bubble record ids. See xano_kiosk_map.json.

These are the rules, not a description of them: the import imports this module
so the documented behaviour and the executed behaviour cannot drift. Run this
file directly to check the rules against the values actually observed in Xano.

Verified against Xano workspace 6 (PWC) table 170 on 2026-08-11, where the
value counts are: card 9347, cash 6035, Cash 14, null 29 (total 15425).
"""

from __future__ import annotations

import json
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Optional
import re

_MAP_PATH = Path(__file__).with_name("xano_kiosk_map.json")

# Xano amounts are plain decimal strings. Confirmed by sorting the column both
# ways: the lexicographic extremes are "0" and "98.44", so there are no blanks,
# no currency symbols, no negatives and no thousands separators anywhere.
_AMOUNT_RE = re.compile(r"^\d+(\.\d+)?$")


class BackfillDataError(ValueError):
    """A row holds a value the rules do not cover. Stop; do not guess."""


def to_cents(amount: str | int | float | None) -> int:
    """Xano's text dollars -> integer cents.

    Decimal, never float: int(float("64.20") * 100) can land on 6419, and a
    one-cent drift across 15k rows is exactly the kind of error nobody spots
    until the totals are compared to the bank.

    >>> to_cents("40"), to_cents("64.20"), to_cents("0"), to_cents("190.00")
    (4000, 6420, 0, 19000)
    """
    if amount is None:
        raise BackfillDataError("amount is null")
    text = str(amount).strip()
    if not _AMOUNT_RE.match(text):
        raise BackfillDataError(f"unexpected amount format: {text!r}")
    return int(
        (Decimal(text) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    )


def normalize_type(value: Optional[str]) -> str:
    """Xano's four spellings -> 'cash' or 'card'.

    Null means cash. All 29 null rows fall between Oct 14 and Oct 24 2025, and
    the first card sale is Oct 27 2025: the tablet could not yet take a card
    when those rows were written, and the table exists to log cash.

    >>> [normalize_type(v) for v in ("cash", "Cash", "card", None)]
    ['cash', 'cash', 'card', 'cash']
    """
    if value is None or not str(value).strip():
        return "cash"
    lowered = str(value).strip().lower()
    if lowered in ("cash", "card"):
        return lowered
    raise BackfillDataError(f"unexpected type: {value!r}")


def _load_kiosk_map() -> dict[str, str]:
    return json.loads(_MAP_PATH.read_text())["map"]


_KIOSK_MAP = _load_kiosk_map()

# Not a kiosk sale: one $40 "Reschedule fee" from April 2026 with no booking.
# Agreed 2026-08-11 to skip it rather than attribute it to a kiosk.
_SKIP_KIOSKS = {"1"}


def kiosk_slug(value: Optional[str]) -> Optional[str]:
    """Xano's Bubble kiosk id -> this app's kiosk slug, or None to skip the row.

    Raises on an unknown id rather than importing money with no kiosk attached:
    a new id means the map is stale and needs a human, not a default.
    """
    key = (value or "").strip()
    if key in _SKIP_KIOSKS:
        return None
    slug = _KIOSK_MAP.get(key)
    if slug is None:
        raise BackfillDataError(f"unmapped kiosk {key!r}; update xano_kiosk_map.json")
    return slug


if __name__ == "__main__":
    # Every value below was observed in the live Xano table, not invented.
    amounts = [
        ("40", 4000), ("0", 0), ("64.20", 6420), ("190.00", 19000),
        ("53.50", 5350), ("42.80", 4280), ("98.44", 9844), ("321.00", 32100),
        ("88.81", 8881), ("26.75", 2675), ("21.40", 2140), ("133.75", 13375),
        ("47.08", 4708), ("92.02", 9202), ("46.01", 4601), ("49.22", 4922),
        ("160.50", 16050), ("58.85", 5885), ("85.60", 8560), ("51.36", 5136),
    ]
    types = [("cash", "cash"), ("Cash", "cash"), ("card", "card"), (None, "cash")]
    kiosks = [
        ("1760408777575x901503164165246200", "kiosk1"),
        ("1767110154468x572695862995220600", "kiosk2"),
        ("1711112568137x325014630279620800", "kiosk3"),
        ("1711112568137x325014630279620900", "kiosk4"),
        ("1", None),
    ]

    failures = []
    for raw, want in amounts:
        got = to_cents(raw)
        if got != want:
            failures.append(f"to_cents({raw!r}) = {got}, want {want}")
    for raw, want in types:
        got = normalize_type(raw)
        if got != want:
            failures.append(f"normalize_type({raw!r}) = {got!r}, want {want!r}")
    for raw, want in kiosks:
        got = kiosk_slug(raw)
        if got != want:
            failures.append(f"kiosk_slug({raw!r}) = {got!r}, want {want!r}")

    # Bad input must stop the import, not slip through with a default.
    for bad in ("", "$40", "40,00", "-5", "abc", None):
        try:
            to_cents(bad)
        except BackfillDataError:
            pass
        else:
            failures.append(f"to_cents({bad!r}) should have raised")
    for bad in ("credit", "efectivo", "CASH MONEY"):
        try:
            normalize_type(bad)
        except BackfillDataError:
            pass
        else:
            failures.append(f"normalize_type({bad!r}) should have raised")
    try:
        kiosk_slug("1711112568137x325014630279620999")
    except BackfillDataError:
        pass
    else:
        failures.append("kiosk_slug should raise on an unmapped id")

    checks = len(amounts) + len(types) + len(kiosks) + 6 + 3 + 1
    if failures:
        print(f"FAIL ({len(failures)} of {checks})")
        for f in failures:
            print("  -", f)
        raise SystemExit(1)
    print(f"OK: {checks} checks passed")
