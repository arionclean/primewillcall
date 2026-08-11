#!/usr/bin/env python3
"""Dry run for the Xano cash_sales backfill. Writes nothing, anywhere.

Answers three questions before a single row is imported:

  1. Do the rules cover the data? Every row is put through
     xano_backfill_rules. Anything the rules do not recognise is reported
     rather than defaulted, so an unknown kiosk or a stray amount format
     surfaces now instead of as a wrong total later.

  2. What would arrive? Row and money totals per kiosk, per tender and per
     day, in New York business time, which is how the app groups them.

  3. Is it right? For the window where BOTH systems already hold the same
     sales, the converted Xano numbers are compared day by day against what
     Supabase actually has. This is the real check: the conversion is only
     trustworthy if it reproduces days we can already see.

Usage:
    python3 scripts/xano_backfill_dryrun.py
    python3 scripts/xano_backfill_dryrun.py --days 40

Input is scripts/_data/xano_cash_sales.json, a read-only export of Xano
workspace 6 table 170. Supabase is read over REST with the service-role key
from .env.local; without that key the comparison is skipped and said so.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
from xano_backfill_rules import (  # noqa: E402
    BackfillDataError,
    kiosk_slug,
    normalize_type,
    to_cents,
)

NY = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parent.parent
EXPORT = ROOT / "scripts" / "_data" / "xano_cash_sales.json"


def money(cents: int) -> str:
    return f"${cents / 100:,.2f}"


def ny_day(epoch_ms: int) -> str:
    return (
        datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc)
        .astimezone(NY)
        .strftime("%Y-%m-%d")
    )


def read_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def supabase_cash_sales(url: str, key: str, since_day: str) -> list[dict]:
    """Every cash_sales row from since_day onward. Paged: PostgREST caps a read."""
    out: list[dict] = []
    offset, page = 0, 1000
    while True:
        query = urllib.parse.urlencode(
            {
                "select": "id,amount_cents,type,kiosk_slug,created_at",
                "created_at": f"gte.{since_day}T00:00:00Z",
                "order": "created_at.asc",
                "limit": str(page),
                "offset": str(offset),
            }
        )
        req = urllib.request.Request(
            f"{url}/rest/v1/cash_sales?{query}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            batch = json.loads(resp.read())
        out.extend(batch)
        if len(batch) < page:
            return out
        offset += page


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--days",
        type=int,
        default=30,
        help="how many recent days to compare against Supabase (default 30)",
    )
    args = ap.parse_args()

    if not EXPORT.exists():
        print(f"Missing {EXPORT}. Export Xano table 170 first.")
        return 1
    rows = json.loads(EXPORT.read_text())
    print(f"Xano cash_sales rows read: {len(rows):,}\n")

    # ---- 1. Rules ---------------------------------------------------------
    planned: list[dict] = []
    skipped: list[dict] = []
    failures: list[str] = []

    for r in rows:
        try:
            slug = kiosk_slug(r.get("kiosk"))
            if slug is None:
                skipped.append(r)
                continue
            planned.append(
                {
                    "xano_id": r["id"],
                    "kiosk_slug": slug,
                    "type": normalize_type(r.get("type")),
                    "amount_cents": to_cents(r.get("amount")),
                    "day": ny_day(r["created_at"]),
                    "booking_ref": r.get("booking_id"),
                    "status": r.get("status"),
                }
            )
        except BackfillDataError as exc:
            failures.append(f"  row {r.get('id')}: {exc}")

    print("1. RULES")
    print(f"   would import : {len(planned):,}")
    print(f"   skipped      : {len(skipped)} (not a kiosk sale, agreed)")
    print(f"   unhandled    : {len(failures)}")
    for line in failures[:20]:
        print(line)
    if len(failures) > 20:
        print(f"  ... and {len(failures) - 20} more")
    if failures:
        print("\n   Unhandled rows must be resolved before importing. Stopping.")
        return 1
    print("   -> every row is covered by the rules\n")

    # ---- 2. What would arrive --------------------------------------------
    by_kiosk: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    by_day: dict[str, dict[str, list[int]]] = defaultdict(
        lambda: defaultdict(lambda: [0, 0])
    )
    for p in planned:
        k = by_kiosk[(p["kiosk_slug"], p["type"])]
        k[0] += 1
        k[1] += p["amount_cents"]
        d = by_day[p["day"]][p["type"]]
        d[0] += 1
        d[1] += p["amount_cents"]

    days = sorted(by_day)
    print("2. WHAT WOULD ARRIVE")
    print(f"   {days[0]} .. {days[-1]}  ({len(days):,} days)\n")
    print(f"   {'kiosk':<8} {'tender':<6} {'rows':>7} {'total':>14}")
    for (slug, tender) in sorted(by_kiosk):
        rows_n, cents = by_kiosk[(slug, tender)]
        print(f"   {slug:<8} {tender:<6} {rows_n:>7,} {money(cents):>14}")
    cash_rows = sum(v[0] for (s, t), v in by_kiosk.items() if t == "cash")
    cash_cents = sum(v[1] for (s, t), v in by_kiosk.items() if t == "cash")
    card_rows = sum(v[0] for (s, t), v in by_kiosk.items() if t == "card")
    print(f"\n   cash {cash_rows:,} rows {money(cash_cents)}")
    print(
        f"   card {card_rows:,} rows  (mirror Stripe charges; the app already"
        f" filters these out of cash totals)\n"
    )

    # ---- 3. Compare the overlap against Supabase -------------------------
    print("3. COMPARE AGAINST SUPABASE (the rows both systems already hold)")
    env = read_env(ROOT / ".env.local")
    url = env.get("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        print("   skipped: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
        print("   not found in .env.local, so there is nothing to compare against.")
        return 0

    since = days[-1]
    since = sorted(d for d in days)[-args.days] if len(days) > args.days else days[0]
    try:
        live = supabase_cash_sales(url, key, since)
    except urllib.error.URLError as exc:
        print(f"   skipped: could not read Supabase ({exc})")
        return 0

    # Per (day, kiosk), not per day: Supabase's live cash sync does not yet
    # cover every tablet, so a day can be short simply because a kiosk never
    # reached this stack. Comparing them lumped together would read as a
    # conversion error when it is a coverage gap, and hide a real error inside
    # the noise. Only (day, kiosk) pairs Supabase actually holds are a verdict
    # on the conversion.
    live_cells: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    for r in live:
        if r.get("type") != "cash":
            continue
        stamp = datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
        day = stamp.astimezone(NY).strftime("%Y-%m-%d")
        cell = live_cells[(day, r.get("kiosk_slug") or "?")]
        cell[0] += 1
        cell[1] += r.get("amount_cents") or 0

    xano_cells: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    for p in planned:
        if p["type"] != "cash" or p["day"] < since:
            continue
        cell = xano_cells[(p["day"], p["kiosk_slug"])]
        cell[0] += 1
        cell[1] += p["amount_cents"]

    if not live_cells:
        print("   Supabase holds no cash rows in this window; nothing to compare.")
        return 0

    covered = sorted(set(live_cells) & set(xano_cells))
    print(f"   {len(covered)} day+kiosk cells are present in BOTH systems\n")
    print(
        f"   {'day':<12} {'kiosk':<8} {'xano':>5} {'supa':>5}   "
        f"{'xano $':>11} {'supa $':>11}  {'diff':>9}"
    )
    mismatches = 0
    for day, slug in covered:
        xr, xc = xano_cells[(day, slug)]
        lr, lc = live_cells[(day, slug)]
        flag = "" if (xr, xc) == (lr, lc) else "  <-- differs"
        if flag:
            mismatches += 1
        print(
            f"   {day:<12} {slug:<8} {xr:>5,} {lr:>5,}   "
            f"{money(xc):>11} {money(lc):>11}  {money(xc - lc):>9}{flag}"
        )

    # Everything Xano has that never reached this stack: the backfill's real job.
    gap_rows = sum(
        v[0] for k, v in xano_cells.items() if k not in live_cells
    )
    gap_cents = sum(
        v[1] for k, v in xano_cells.items() if k not in live_cells
    )
    by_missing_kiosk: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for (day, slug), v in xano_cells.items():
        if (day, slug) not in live_cells:
            by_missing_kiosk[slug][0] += v[0]
            by_missing_kiosk[slug][1] += v[1]

    print(f"\n   In this window alone, cash Supabase never received:")
    for slug in sorted(by_missing_kiosk):
        n, c = by_missing_kiosk[slug]
        print(f"     {slug:<8} {n:>5,} rows {money(c):>12}")
    print(f"     {'total':<8} {gap_rows:>5,} rows {money(gap_cents):>12}")

    print()
    if mismatches:
        print(f"   {mismatches} of {len(covered)} shared cells differ.")
        print("   See section 4: some of this is coverage, not conversion.")
    else:
        print(f"   All {len(covered)} shared cells match to the cent.")

    # ---- 4. Where the import has to stop ---------------------------------
    #
    # Supabase's cash rows are NOT copies of Xano's. The kiosk app writes them
    # here directly, with its own KS-xxxx reference, while Xano's rows for the
    # same sales carry numeric ids. dedup_key is "<KS ref>:<tender>", so a
    # Xano row and its Supabase twin share no key: re-importing a period this
    # stack already covers would silently double it.
    #
    # So the import runs up to the day each kiosk started writing here, and
    # stops. Anything after that is a separate decision, not a copy.
    print("\n4. WHERE THE IMPORT HAS TO STOP")
    print("   Supabase rows use KS-refs, Xano rows use numeric ids: no shared")
    print("   key, so importing a covered period would duplicate it.\n")

    first_seen: dict[str, str] = {}
    for r in live:
        stamp = datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
        day = stamp.astimezone(NY).strftime("%Y-%m-%d")
        slug = r.get("kiosk_slug") or "?"
        if slug not in first_seen or day < first_seen[slug]:
            first_seen[slug] = day

    safe = defaultdict(lambda: [0, 0])
    risky = defaultdict(lambda: [0, 0])
    for p in planned:
        slug = p["kiosk_slug"]
        cut = first_seen.get(slug)
        bucket = safe if (cut is None or p["day"] < cut) else risky
        bucket[slug][0] += 1
        bucket[slug][1] += p["amount_cents"] if p["type"] == "cash" else 0

    print(f"   {'kiosk':<8} {'writes here since':<18} {'safe rows':>10} {'safe cash':>13} {'needs a call':>13}")
    for slug in sorted(set(list(safe) + list(risky))):
        cut = first_seen.get(slug, "never")
        print(
            f"   {slug:<8} {cut:<18} {safe[slug][0]:>10,} "
            f"{money(safe[slug][1]):>13} {risky[slug][0]:>13,}"
        )
    tot_safe = sum(v[0] for v in safe.values())
    tot_safe_cash = sum(v[1] for v in safe.values())
    tot_risky = sum(v[0] for v in risky.values())
    print(f"   {'TOTAL':<8} {'':<18} {tot_safe:>10,} {money(tot_safe_cash):>13} {tot_risky:>13,}")

    print(f"\n   Import now, no duplicate risk : {tot_safe:,} rows, {money(tot_safe_cash)} cash")
    print(f"   Inside the live window        : {tot_risky:,} rows need a decision")
    print("     (Supabase already holds some of these; the rest are sales it")
    print("      never received. They cannot be told apart automatically.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
