#!/usr/bin/env python3
"""
Fill bookings.booked_at from Xano: when each booking was actually SOLD.

Why this exists. Analytics can say how full a departure is, because it groups on
starts_at. It cannot say which source is growing, because that needs the date the
reservation came in and this platform has no usable one. bookings.created_at is the
row's birthday HERE: 79,626 bookings were born in three minutes on 2026-06-03 when the
Xano history was imported, and another 3,920 on 2026-07-11. A sales chart off that
column would show eighty thousand sales on one June afternoon and nothing before it.

Xano's own created_at is real. Bucketed by month across all 96,907 of its bookings it
is a smooth curve from March 2024 to today, growing month on month, and its busiest
single minute holds 29 bookings, which is a good morning rather than an import.

booked_at stays NULL for a booking born on this platform, whose own created_at is
already the truth. Readers use coalesce(booked_at, created_at).

What it does.
  1. Pages the PUBLIC, read-only Xano bookings endpoint, the same one
     scripts/import_legacy_bookings.py and scripts/backfill_booking_kiosk.py use:
         GET https://xmhi-aj9d-cnsb.n7.xano.io/api:0AUqUbBn/booking/v1?page=N&per_page=1000
     Xano is never written to. This script cannot write to Xano at all.
  2. Indexes every row under all three shapes our legacy_id has taken over the years:
     the internal_id ("KS-ABC123"), the Bubble id the first import carried in
     unique_id, and "xano-<row id>", the sync's fallback when unique_id was empty.
  3. Reads our bookings that came from Xano (legacy_id is not null) and have no
     booked_at yet, then with --live writes it in batches.

Safe to run twice: it only ever fills a NULL booked_at, so a second run writes nothing.

What it does NOT trigger, checked against the schema before writing this:
  * The Xano mirror. enqueue_xano_mirror watches starts_at, business_tour_id, status,
    pax, checked_in_at, notes and due_cents. booked_at is not one of them, so no queue
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
  python3 scripts/backfill_booking_booked_at.py                 # dry run, reports only
  python3 scripts/backfill_booking_booked_at.py --live          # write, 200 a batch

  Two steps, so Realtime is paused only for the writes:
  python3 scripts/backfill_booking_booked_at.py --cache /tmp/booked.json
  ... pause Realtime ...
  python3 scripts/backfill_booking_booked_at.py --live --cache /tmp/booked.json --sleep 0 --batch 500
"""
import argparse
import collections
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

XANO_LIST = "https://xmhi-aj9d-cnsb.n7.xano.io/api:0AUqUbBn/booking/v1?per_page=1000&page="
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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


def sb_rpc(base, key, fn, body):
    """One call per batch. Every booking has its own timestamp, so there is nothing to
    group into a shared PATCH: without this it would be one round trip per booking."""
    # Retried: a batch this size occasionally comes back 500 or drops the TLS
    # connection, and the write is idempotent (it only fills NULLs), so repeating
    # one costs nothing and never double-writes.
    for attempt in range(5):
        req = urllib.request.Request(
            f"{base}/rest/v1/rpc/{fn}",
            data=json.dumps(body).encode(),
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read() or b"0")
        except Exception as e:  # HTTPError, URLError, ssl.SSLError
            if attempt == 4:
                raise
            print(f"\n  batch retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))


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


def iso(ms):
    """Xano stores epoch milliseconds. Anything not a sane instant is dropped, not
    guessed: a wrong sale date is worse than a missing one."""
    try:
        ms = int(ms)
    except (TypeError, ValueError):
        return None
    if ms < 1_000_000_000_000 or ms > 4_000_000_000_000:
        return None
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.UTC).isoformat().replace("+00:00", "Z")


def write(base, key, pairs, args):
    total = len(pairs)
    print(f"writing in batches of {args.batch}, {args.sleep}s between...")
    done, written = 0, 0
    for i in range(0, total, args.batch):
        chunk = pairs[i:i + args.batch]
        written += int(sb_rpc(base, key, "set_booked_at_bulk", {"p_rows": chunk}) or 0)
        done += len(chunk)
        print(f"  {done}/{total}", end="\r", flush=True)
        if args.sleep:
            time.sleep(args.sleep)
    print(f"\ndone: {written} bookings dated ({done} sent).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="write; without it, report only")
    ap.add_argument("--batch", type=int, default=2000,
                    help="rows per update (default 2000). Measured: 500 rows cost 7.7ms "
                         "each, 2000 cost 4.2ms, and 5000 breaks the connection. The "
                         "per-row cost is the six row triggers on bookings, none of "
                         "which has anything to do for this column.")
    ap.add_argument("--sleep", type=float, default=1.0,
                    help="seconds between batches, to spare Realtime (default 1)")
    ap.add_argument("--cache", metavar="FILE",
                    help="save the matched id/date pairs here instead of writing, or, "
                         "with --live, write from a file saved earlier. Reading Xano "
                         "takes about 90 seconds and touches nothing, so doing it first "
                         "keeps Realtime paused only for the writes.")
    args = ap.parse_args()

    base, key = env_keys()

    if args.live and args.cache and os.path.exists(args.cache):
        with open(args.cache) as f:
            pairs = json.load(f)
        print(f"{len(pairs)} pairs from {args.cache}")
        write(base, key, pairs, args)
        return

    # 1. Xano: every key shape -> the sale date.
    print("reading Xano bookings...")
    want, page, scanned, undated = {}, 1, 0, 0
    while True:
        data = xano_page(page)
        items = data.get("items", [])
        scanned += len(items)
        for r in items:
            when = iso(r.get("created_at"))
            if not when:
                undated += 1
                continue
            for k in (r.get("internal_id"), r.get("unique_id")):
                k = str(k or "").strip()
                if k:
                    want[k] = when
            if r.get("id") is not None:
                want[f"xano-{r['id']}"] = when
        if not data.get("nextPage"):
            break
        page = data["nextPage"]
        if page % 20 == 0:
            print(f"  page {page}, {len(want)} keys so far")
    print(f"scanned {scanned} Xano bookings over {page} pages; {undated} carry no usable date")

    # 2. Ours: bookings that came from Xano and have no sale date yet.
    print("reading our bookings without a sale date...")
    mine, offset = [], 0
    while True:
        rows = sb_get(
            base, key,
            "bookings?select=id,legacy_id,xano_internal_id"
            "&booked_at=is.null&legacy_id=not.is.null"
            f"&order=id.asc&limit=1000&offset={offset}",
        )
        mine.extend(rows)
        if len(rows) < 1000:
            break
        offset += 1000
        if offset % 10000 == 0:
            print(f"  {offset}...")
    print(f"{len(mine)} bookings here have no sale date yet")

    # 3. Match.
    pairs, missed = [], 0
    for b in mine:
        when = (want.get(str(b.get("legacy_id") or "").strip())
                or want.get(str(b.get("xano_internal_id") or "").strip()))
        if when:
            pairs.append({"id": b["id"], "booked_at": when})
        else:
            missed += 1
    total = len(pairs)
    print(f"\nmatched {total}, no match in Xano for {missed}")
    months = collections.Counter(p["booked_at"][:7] for p in pairs)
    print("sale dates by month (a real curve, not an import spike):")
    for mth, n in sorted(months.items()):
        print(f"  {mth}  {n}")

    if args.cache:
        with open(args.cache, "w") as f:
            json.dump(pairs, f)
        print(f"\nsaved {total} pairs to {args.cache}. "
              f"Pause Realtime, then: --live --cache {args.cache} --sleep 0")
        return

    if not args.live:
        print("\ndry run. re-run with --live to write.")
        return

    write(base, key, pairs, args)


if __name__ == "__main__":
    main()
