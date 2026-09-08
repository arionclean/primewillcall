#!/usr/bin/env python3
"""Stamp every booking that came from Xano with where it lives in Xano.

The Xano mirror (docs/xano-mirror.md) sends an edit made in this app back to the
Xano row by its numeric id (bookings.xano_booking_id), which it finds through the
row's internal id (bookings.xano_internal_id) when it has to. Going forward the
sync stamps both on every echo, and the mirrors stamp the internal id before they
call Xano. Bookings synced BEFORE that have neither, and most of them cannot be
found any other way (their public_token is one we generated, not Xano's
confirmation id). This one-time script fills the gap.

  1. Reads every Xano booking through the public listing (read-only; the same
     read the ghost script does) and every Supabase booking with a legacy_id that
     still lacks a Xano id.
  2. Matches them the way the ghost script does: legacy_id in
     {ota-<booking_reference>, unique_id, internal_id, bookingConfirmation_id,
     xano-<id>}, else public_token = bookingConfirmation_id, else legacy_reference
     = booking_reference or internal_id. A key that several Xano rows share (the
     PR- references some bookings reuse) is ambiguous and is skipped, never guessed.
  3. Dry run prints the counts. With --live it writes xano_booking_id and
     xano_internal_id, one PATCH per booking through PostgREST (a few at a time),
     with the x-sync-origin: xano header so nothing is mirrored back. Xano is never
     written to.

  python3 scripts/stamp_xano_ids.py                   # dry run, tours from 14 days ago on
  python3 scripts/stamp_xano_ids.py --live            # write the ids for that window
  python3 scripts/stamp_xano_ids.py --all --live      # every booking (a big write)

The window (--since-days, default 14) keeps the write to the bookings staff can
still realistically edit. Every stamped row is an UPDATE on bookings: updated_at
moves and Realtime tells every open bookings screen, so 90k rows at once is a
burden, not a service. A past booking edited later fails once with "Xano has no row
for this booking"; re-run with a wider window then.
"""
import argparse
import collections
import concurrent.futures
import datetime
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reconcile_xano_ghosts import ROOT, clean, env_keys, fetch_xano  # noqa: E402


def fetch_unstamped(url, key, since):
    """Xano-synced bookings still missing a Xano id, keyset-paged on id."""
    cols = "id,legacy_id,legacy_reference,public_token,xano_internal_id,xano_booking_id"
    # UTC with a Z: a "+00:00" offset would read as a space in the query string.
    window = f"&starts_at=gte.{since.strftime('%Y-%m-%dT%H:%M:%SZ')}" if since else ""
    rows, last = [], None
    while True:
        after = f"&id=gt.{last}" if last else ""
        req = urllib.request.Request(
            f"{url}/rest/v1/bookings?select={cols}&legacy_id=not.is.null{window}"
            f"&or=(xano_booking_id.is.null,xano_internal_id.is.null)&order=id.asc&limit=1000{after}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            chunk = json.loads(r.read())
        rows.extend(chunk)
        if len(chunk) < 1000:
            return rows
        last = chunk[-1]["id"]


def index_xano(rows):
    """key -> [xano rows]. Lists, so a shared key is visible and skipped."""
    by_key, by_token, by_ref = (collections.defaultdict(list) for _ in range(3))
    for r in rows:
        ref = clean(r.get("booking_reference"))
        if ref and not ref.lower().startswith("kiosk-sale"):
            by_key["ota-" + ref].append(r)
        for f in ("unique_id", "internal_id", "bookingConfirmation_id"):
            v = clean(r.get(f))
            if v:
                by_key[v].append(r)
        by_key[f"xano-{r['id']}"].append(r)
        tok = clean(r.get("bookingConfirmation_id"))
        if tok:
            by_token[tok].append(r)
        if ref:
            by_ref[ref].append(r)
        iid = clean(r.get("internal_id"))
        if iid:
            by_ref[iid].append(r)
    return by_key, by_token, by_ref


def find(sb_row, by_key, by_token, by_ref):
    """The one Xano row for a Supabase booking, or None (unmatched or ambiguous)."""
    for table, value in ((by_key, sb_row["legacy_id"]),
                         (by_token, sb_row.get("public_token")),
                         (by_ref, sb_row.get("legacy_reference"))):
        hits = table.get(value) if value else None
        if hits:
            return hits[0] if len(hits) == 1 else None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="write the ids")
    ap.add_argument("--since-days", type=int, default=14,
                    help="only bookings whose tour starts from this many days ago (default 14)")
    ap.add_argument("--all", action="store_true", help="every booking, no window")
    ap.add_argument("--cache", default=os.path.join(ROOT, ".reconcile-cache"))
    args = ap.parse_args()
    url, key = env_keys()
    since = None if args.all else (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=args.since_days))

    print("reading Supabase (bookings from Xano still without a Xano id"
          + (f", tours from {since.date().isoformat()} on" if since else "") + ")...")
    sb = fetch_unstamped(url, key, since)
    print(f"  {len(sb):,} rows")

    print("reading Xano (public listing, read-only)...")
    xano = fetch_xano(args.cache)
    print(f"  {len(xano):,} rows")
    by_key, by_token, by_ref = index_xano(xano)

    patches, unmatched, ambiguous = [], 0, 0
    for r in sb:
        x = find(r, by_key, by_token, by_ref)
        if x is None:
            # Distinguish "no Xano row" from "several": only the latter is ambiguous.
            keyed = by_key.get(r["legacy_id"]) or by_token.get(r.get("public_token") or "") \
                or by_ref.get(r.get("legacy_reference") or "")
            if keyed:
                ambiguous += 1
            else:
                unmatched += 1
            continue
        # Every object carries the same three keys: a bulk upsert needs uniform rows.
        # The values are Xano's own, so re-sending one already stamped changes nothing.
        patches.append({
            "id": r["id"],
            "xano_booking_id": x["id"],
            "xano_internal_id": clean(x.get("internal_id")) or r.get("xano_internal_id"),
        })

    print(f"matched: {len(patches):,}; unmatched (deleted in Xano, the ghost script's job): {unmatched:,}; "
          f"ambiguous (a shared key, skipped): {ambiguous:,}")
    if not args.live:
        print("\nDRY RUN. Nothing written. Re-run with --live to stamp the ids.")
        return

    # One PATCH per booking, a few at a time. A bulk upsert on the primary key is not
    # an option: Postgres checks NOT NULL on the tuple before the conflict clause, so
    # a row sent with only the two columns is rejected before it can merge.
    def stamp(patch):
        body = {k: v for k, v in patch.items() if k != "id"}
        req = urllib.request.Request(
            f"{url}/rest/v1/bookings?id=eq.{patch['id']}",
            data=json.dumps(body).encode(),
            method="PATCH",
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Content-Type": "application/json", "Prefer": "return=minimal",
                     "x-sync-origin": "xano"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60):
                    return True
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    print(f"  {patch['id']}: {e}", file=sys.stderr)
                    return False
                time.sleep(1 + attempt)

    done, failed = 0, 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for ok in pool.map(stamp, patches):
            done += ok
            failed += not ok
            if (done + failed) % 500 == 0:
                print(f"  stamped {done:,}/{len(patches):,}", flush=True)
    print(f"LIVE: stamped {done:,} bookings" + (f", {failed:,} failed (see stderr)" if failed else ""))


if __name__ == "__main__":
    main()
