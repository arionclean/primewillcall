#!/usr/bin/env python3
"""
Fill bookings.kiosk_id from Xano, so analytics can name the kiosk that sold a booking
instead of guessing it.

Why this exists. A kiosk booking here never recorded which tablet sold it. The Sources
list inferred it by matching the booking's legacy_id against cash_sales.booking_ref, or
kiosk_sales.booking_id, or a kiosk stripe_transaction. Sales have only been recorded on
this platform since 2026-07-12, so every kiosk booking older than that resolved to
nothing and 13,509 of them (41,492 guests) collapsed into one row named
"Kiosk (unknown)". The same guess fails for a recent booking whose sale row never
landed, which is how a duplicate kiosk booking went unnoticed for three days.

Xano has always known. Its booking row carries `kiosk` (the Bubble kiosk id, which is
kiosks.xano_kiosk_id here) and, on a kiosk sale only, `supplier` holds the slug
("kiosk2") rather than a business name. Its `internal_id` is our legacy_id, so the two
sides line up one to one.

What it does.
  1. Pages the PUBLIC, read-only Xano bookings endpoint, the same one
     scripts/import_legacy_bookings.py uses:
         GET https://xmhi-aj9d-cnsb.n7.xano.io/api:0AUqUbBn/booking/v1?page=N&per_page=1000
     Xano is never written to. This script cannot write to Xano at all.
  2. Keeps only rows whose booking_channel starts with "kiosk-sale". Xano stamps a
     `kiosk` value on OTA bookings too, where it means something else, so the channel
     is the gate.
  3. Resolves the kiosk: the Xano id first, the slug second, and neither means the row
     is reported and skipped. Better an unnamed booking than one credited to the wrong
     tablet.
  4. Reads our kiosk bookings that still have no kiosk_id, matches on legacy_id, and
     with --live writes kiosk_id in batches.

Safe to run twice: it only ever fills a NULL kiosk_id, so a second run writes nothing.

What it does NOT trigger, checked against the schema before writing this:
  * The Xano mirror. enqueue_xano_mirror watches starts_at, business_tour_id, status,
    pax, checked_in_at, notes and due_cents. kiosk_id is not one of them, so no queue
    row is created and nothing is sent to Xano. There is no loop: this script reads
    Xano and never writes it, so Xano has nothing new to echo.
  * The audit logs. log_booking_changes records eight specific columns, none of them
    this one. log_staff_change skips any write with no auth.uid(), which a service-role
    write is.
  * The capability trigger. It returns immediately when there is no staff session.
  The one real effect is Realtime: bookings is published with full row images and the
  live screens filter only by business, so every update is pushed to every open screen.
  Hence --sleep between batches. To run it at full speed, take the table out of the
  publication first and put it back after:
      alter publication supabase_realtime drop table public.bookings;
      ... run with --sleep 0 ...
      alter publication supabase_realtime add table public.bookings;
  While it is out, open screens stop updating live. They are correct again on reload,
  and nothing is replayed, so do it outside operating hours.

Usage.
  python3 scripts/backfill_booking_kiosk.py                 # dry run, reports only
  python3 scripts/backfill_booking_kiosk.py --live          # write, 200 a batch
  python3 scripts/backfill_booking_kiosk.py --live --sleep 0 --batch 500
"""
import argparse
import collections
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

XANO_LIST = "https://xmhi-aj9d-cnsb.n7.xano.io/api:0AUqUbBn/booking/v1?per_page=1000&page="
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIOSK_CHANNEL = "kiosk-sale"


def env_keys():
    env = {}
    for line in open(os.path.join(ROOT, ".env.local")):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    return env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_ROLE_KEY"]


def sb_get(base, key, path):
    req = urllib.request.Request(
        f"{base}/rest/v1/{path}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def sb_patch(base, key, path, body):
    req = urllib.request.Request(
        f"{base}/rest/v1/{path}",
        data=json.dumps(body).encode(),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status


def xano_page(page):
    """One page of Xano bookings. Retries: the endpoint is public and occasionally slow."""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f"{XANO_LIST}{page}", timeout=120) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 3:
                raise
            print(f"  page {page} retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))


def kiosk_lookup(base, key):
    """Xano kiosk id -> our kiosk uuid, and slug -> our kiosk uuid."""
    rows = sb_get(base, key, "kiosks?select=id,slug,xano_kiosk_id")
    by_xano, by_slug = {}, {}
    for k in rows:
        if k.get("xano_kiosk_id"):
            by_xano[str(k["xano_kiosk_id"])] = k["id"]
        if k.get("slug"):
            by_slug[str(k["slug"]).lower()] = k["id"]
    return by_xano, by_slug


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="write; without it, report only")
    ap.add_argument("--batch", type=int, default=200, help="rows per update (default 200)")
    ap.add_argument("--sleep", type=float, default=1.0,
                    help="seconds between batches, to spare Realtime (default 1)")
    args = ap.parse_args()

    base, key = env_keys()
    by_xano, by_slug = kiosk_lookup(base, key)
    print(f"kiosks known here: {len(by_slug)} ({', '.join(sorted(by_slug))})")

    # 1. Xano: internal_id -> our kiosk uuid, for kiosk sales only.
    print("reading Xano bookings...")
    want, unknown, page, scanned = {}, collections.Counter(), 1, 0
    while True:
        data = xano_page(page)
        items = data.get("items", [])
        scanned += len(items)
        for r in items:
            if not str(r.get("booking_channel") or "").lower().startswith(KIOSK_CHANNEL):
                continue
            kid = by_xano.get(str(r.get("kiosk") or "").strip())
            if not kid:
                kid = by_slug.get(str(r.get("supplier") or "").strip().lower())
            if not kid:
                unknown[f"kiosk={r.get('kiosk')} supplier={r.get('supplier')}"] += 1
                continue
            # Our legacy_id was written by three different importers over time, so a
            # Xano row has to be findable under all three shapes it could have taken:
            # its internal_id ("KS-ABC123"), the Bubble id the first import carried in
            # unique_id, and "xano-<row id>", the sync's fallback when unique_id was
            # empty (11,881 kiosk bookings look like that).
            for k in (r.get("internal_id"), r.get("unique_id")):
                k = str(k or "").strip()
                if k:
                    want[k] = kid
            if r.get("id") is not None:
                want[f"xano-{r['id']}"] = kid
        if not data.get("nextPage"):
            break
        page = data["nextPage"]
        if page % 20 == 0:
            print(f"  page {page}, {len(want)} kiosk bookings so far")
    print(f"scanned {scanned} Xano bookings over {page} pages; {len(want)} are kiosk sales we can place")
    if unknown:
        print("kiosk values we could not place (skipped):")
        for k, n in unknown.most_common(10):
            print(f"  {n:6d}  {k}")

    # 2. Ours: kiosk bookings with no kiosk yet.
    print("reading our kiosk bookings without a kiosk...")
    mine, offset = [], 0
    while True:
        rows = sb_get(
            base, key,
            "bookings?select=id,legacy_id,xano_internal_id&kiosk_id=is.null"
            "&source_channel=in.(kiosk-sale-cash,kiosk-sale-card,kiosk-sale-tap)"
            f"&order=id.asc&limit=1000&offset={offset}",
        )
        mine.extend(rows)
        if len(rows) < 1000:
            break
        offset += 1000
    print(f"{len(mine)} bookings here have no kiosk yet")

    # 3. Match.
    by_kiosk = collections.defaultdict(list)
    missed = 0
    for b in mine:
        kid = (want.get(str(b.get("legacy_id") or "").strip())
               or want.get(str(b.get("xano_internal_id") or "").strip()))
        if kid:
            by_kiosk[kid].append(b["id"])
        else:
            missed += 1
    total = sum(len(v) for v in by_kiosk.values())
    slug_of = {v: k for k, v in by_slug.items()}
    print(f"\nmatched {total}, no match in Xano for {missed}")
    for kid, ids in sorted(by_kiosk.items(), key=lambda kv: -len(kv[1])):
        print(f"  {slug_of.get(kid, kid):10s} {len(ids):6d}")

    if not args.live:
        print("\ndry run. re-run with --live to write.")
        return

    print(f"\nwriting in batches of {args.batch}, {args.sleep}s between...")
    done = 0
    for kid, ids in by_kiosk.items():
        for i in range(0, len(ids), args.batch):
            chunk = ids[i:i + args.batch]
            path = "bookings?id=in.(" + ",".join(chunk) + ")&kiosk_id=is.null"
            sb_patch(base, key, path, {"kiosk_id": kid})
            done += len(chunk)
            print(f"  {done}/{total}", end="\r", flush=True)
            if args.sleep:
                time.sleep(args.sleep)
    print(f"\ndone: {done} bookings stamped.")


if __name__ == "__main__":
    main()
