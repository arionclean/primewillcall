#!/usr/bin/env python3
"""Backfill Xano cash_sales into Supabase. Dry run unless --commit is passed.

Xano is only ever READ, and only from the export in scripts/_data. This script
cannot write to Xano at all.

Three things keep it safe to run, and to re-run:

  Idempotent      Every row carries dedup_key = "xano-cash:<xano id>", which is
                  unique in the table. Writes are upserts on that key, so
                  running twice imports nothing the second time. The kiosk app's
                  own keys look like "KS-ABC123:cash", so the two can never
                  collide.

  Bounded         Each kiosk stops at the day it began writing here directly.
                  Supabase's rows are the tablet's own records, not copies of
                  Xano's, and they share no reference with Xano, so importing a
                  covered period would silently double it. Crossing that line
                  needs --include-live-window, said out loud.

  Staged          --month imports one month at a time so the result can be
                  checked against Xano before doing the rest.

Usage:
    python3 scripts/xano_backfill_cash.py                      # plan only
    python3 scripts/xano_backfill_cash.py --month 2026-07      # plan one month
    python3 scripts/xano_backfill_cash.py --month 2026-07 --commit
    python3 scripts/xano_backfill_cash.py --commit             # everything safe

Known limitation, by design: Xano's cash rows reference bookings by an id this
stack does not carry (0 of a 300-row sample matched bookings.legacy_id), so an
imported sale shows its amount, kiosk, tender and date, but no customer name.
The reference is still stored in booking_ref for later.
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
BATCH = 500

# Marks every row this script creates, so a backfilled sale is always
# distinguishable from one the tablet wrote, and the whole import can be
# found (or undone) with a single query. Nothing in the app reads this column.
BACKFILL_SOURCE = "xano-backfill"


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


class Supabase:
    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/")
        self.key = key

    def _req(self, path: str, *, method="GET", body=None, extra_headers=None):
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        }
        headers.update(extra_headers or {})
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.url}/rest/v1/{path}", data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as exc:
            raise SystemExit(
                f"Supabase {method} {path} failed: {exc.code} {exc.read().decode()[:500]}"
            )

    def get(self, path: str):
        return self._req(path)

    def upsert(self, table: str, rows: list[dict], on_conflict: str):
        return self._req(
            f"{table}?on_conflict={on_conflict}",
            method="POST",
            body=rows,
            extra_headers={
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
        )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="actually write (default: plan only)")
    ap.add_argument("--month", help="limit to one month, e.g. 2026-07")
    ap.add_argument(
        "--include-live-window",
        action="store_true",
        help="also import dates each kiosk already writes here (RISK: duplicates)",
    )
    args = ap.parse_args()

    if not EXPORT.exists():
        print(f"Missing {EXPORT}. Export Xano table 170 first.")
        return 1

    env = read_env(ROOT / ".env.local")
    url = env.get("NEXT_PUBLIC_SUPABASE_URL", "")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        print("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local")
        return 1
    sb = Supabase(url, key)

    # Kiosk slug -> its row here. A slug missing from this table is a hard stop:
    # the sale would land with no business and be invisible to that manager.
    kiosks = {
        k["slug"]: k
        for k in sb.get("kiosks?select=id,slug,business_id&slug=not.is.null")
    }

    # The line each kiosk stops at: the first day it wrote here itself.
    live = sb.get("cash_sales?select=kiosk_slug,created_at&order=created_at.asc&limit=10000")
    first_seen: dict[str, str] = {}
    for r in live:
        day = (
            datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
            .astimezone(NY)
            .strftime("%Y-%m-%d")
        )
        slug = r.get("kiosk_slug")
        if slug and (slug not in first_seen or day < first_seen[slug]):
            first_seen[slug] = day

    rows = json.loads(EXPORT.read_text())
    planned: list[dict] = []
    skipped_not_kiosk = 0
    held_live_window: dict[str, int] = defaultdict(int)
    out_of_month = 0
    failures: list[str] = []

    for r in rows:
        try:
            slug = kiosk_slug(r.get("kiosk"))
            if slug is None:
                skipped_not_kiosk += 1
                continue
            if slug not in kiosks:
                raise BackfillDataError(f"kiosk {slug} is not in the kiosks table")

            day = ny_day(r["created_at"])
            if args.month and not day.startswith(args.month):
                out_of_month += 1
                continue

            cut = first_seen.get(slug)
            if cut and day >= cut and not args.include_live_window:
                held_live_window[slug] += 1
                continue

            k = kiosks[slug]
            planned.append(
                {
                    "business_id": k["business_id"],
                    "kiosk_id": k["id"],
                    "kiosk_slug": slug,
                    "booking_ref": r.get("booking_id") or None,
                    "amount_cents": to_cents(r.get("amount")),
                    "type": normalize_type(r.get("type")),
                    "product": r.get("product") or None,
                    "status": r.get("status") or "success",
                    "source": BACKFILL_SOURCE,
                    "created_at": datetime.fromtimestamp(
                        r["created_at"] / 1000, tz=timezone.utc
                    ).isoformat(),
                    "dedup_key": f"xano-cash:{r['id']}",
                }
            )
        except BackfillDataError as exc:
            failures.append(f"  row {r.get('id')}: {exc}")

    if failures:
        print(f"{len(failures)} rows the rules do not cover. Nothing was written.\n")
        for line in failures[:20]:
            print(line)
        if len(failures) > 20:
            print(f"  ... and {len(failures) - 20} more")
        return 1

    # ---- the plan ---------------------------------------------------------
    by_kiosk: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    days: set[str] = set()
    for p in planned:
        by_kiosk[p["kiosk_slug"]][0] += 1
        if p["type"] == "cash":
            by_kiosk[p["kiosk_slug"]][1] += p["amount_cents"]
        days.add(p["created_at"][:10])

    mode = "COMMIT" if args.commit else "DRY RUN (nothing will be written)"
    scope = f"month {args.month}" if args.month else "all safe dates"
    print(f"Xano cash backfill  |  {mode}  |  {scope}\n")
    print(f"  source rows           : {len(rows):,}")
    print(f"  not a kiosk sale      : {skipped_not_kiosk}")
    if args.month:
        print(f"  outside {args.month}       : {out_of_month:,}")
    if held_live_window:
        total_held = sum(held_live_window.values())
        print(f"  held back (live window): {total_held:,}")
        for slug in sorted(held_live_window):
            print(f"      {slug} on/after {first_seen[slug]}: {held_live_window[slug]:,}")
    print(f"  to import             : {len(planned):,}\n")

    if not planned:
        print("Nothing to do.")
        return 0

    print(f"  {'kiosk':<8} {'rows':>8} {'cash value':>14}")
    for slug in sorted(by_kiosk):
        n, cents = by_kiosk[slug]
        print(f"  {slug:<8} {n:>8,} {money(cents):>14}")
    print(f"  {'TOTAL':<8} {len(planned):>8,} "
          f"{money(sum(v[1] for v in by_kiosk.values())):>14}")
    print(f"  dates {min(days)} .. {max(days)}\n")

    if args.include_live_window:
        print("  !! --include-live-window is on. Dates this stack already covers")
        print("     will be imported and CAN duplicate existing sales.\n")

    if not args.commit:
        print("Dry run. Re-run with --commit to write.")
        return 0

    # ---- write ------------------------------------------------------------
    written = 0
    for i in range(0, len(planned), BATCH):
        chunk = planned[i : i + BATCH]
        sb.upsert("cash_sales", chunk, on_conflict="dedup_key")
        written += len(chunk)
        print(f"  upserted {written:,}/{len(planned):,}")

    # ---- verify -----------------------------------------------------------
    check = sb.get(
        f"cash_sales?select=id&source=eq.{BACKFILL_SOURCE}&limit=1",
        )
    total = sb._req(
        f"cash_sales?select=id&source=eq.{BACKFILL_SOURCE}",
        extra_headers={"Prefer": "count=exact", "Range": "0-0"},
    )
    print(f"\nDone. {written:,} rows upserted.")
    print(f"Backfilled rows now in cash_sales: run this to see them")
    print(f"  select count(*), sum(amount_cents) from cash_sales")
    print(f"   where source = '{BACKFILL_SOURCE}';")
    print("\nRe-running this command imports nothing further (upsert on dedup_key).")
    _ = check, total
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
