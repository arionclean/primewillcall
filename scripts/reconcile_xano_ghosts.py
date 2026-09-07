#!/usr/bin/env python3
"""
Xano vs Supabase bookings reconciliation: find bookings that still count here after
Xano deleted them, and VOID them (never delete).

Why this exists. Xano's booking trigger sends `$input.new` to xano-booking-sync, which
is empty on a delete, so a booking removed in Bubble/Xano lives on here and keeps
counting toward analytics. Xano "canceled" does propagate; only deletes are lost.

What it does.
  1. Reads Xano through the PUBLIC, read-only listing
     GET https://xmhi-aj9d-cnsb.n7.xano.io/api:0AUqUbBn/booking/v1?page=N&per_page=1000
     (id desc, no auth), caching each page under --cache (default: ./.reconcile-cache).
     Xano is never written to.
  2. Reads every Supabase booking that came from Xano (legacy_id set) with the service
     role key from .env.local (the key is never printed).
  3. A Supabase row is PRESENT in Xano if any of these hit, mirroring the keying in
     supabase/functions/xano-booking-sync/index.ts plus every other identity Xano carries:
        legacy_id        in {ota-<booking_reference>, unique_id, internal_id,
                             bookingConfirmation_id, xano-<id>} of any Xano row
        public_token     equals a Xano bookingConfirmation_id (the 9-char Bubble token)
        legacy_reference equals a Xano booking_reference or internal_id
     Anything else is a GHOST. Ghosts already cancelled are left alone.
     Two guards against a booking that is simply NEWER than the Xano read: the newest
     Xano pages are always re-downloaded (a cached dump goes stale in minutes, and the
     first live run voided 13 fresh bookings that way, restored the same minute), and
     a Supabase row created after the Xano read minus a margin is never judged.
  4. Dry run prints the classification. With --live it voids the active ghosts through
     PostgREST: status -> cancelled plus the void stamp (voided_at, void_reason,
     voided_from_status; voided_by_staff_id stays null: this is the system, not a
     person). The row stays. The database triggers do the rest (a voided booking is
     kept cancelled, its pending messages and review asks are cancelled). An owner can
     restore any of them from the Bookings page.

Usage.
  python3 scripts/reconcile_xano_ghosts.py            # dry run, full report
  python3 scripts/reconcile_xano_ghosts.py --live     # void the active ghosts
  python3 scripts/reconcile_xano_ghosts.py --refresh  # ignore the page cache

First run: 2026-09-07, 278 ghosts (1,337 pax, tours June..September 2026) voided.
"""
import argparse
import collections
import datetime
import json
import os
import sys
import time
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


def clean(v):
    v = v.strip() if isinstance(v, str) else v
    return v or None


FRESH_PAGES = 3  # always re-read the newest pages: new bookings land there


def fetch_xano(cache, refresh):
    """Every Xano booking, newest first. Cached per page; --refresh re-downloads.
    The first FRESH_PAGES are re-downloaded on every run regardless, so a booking
    made since the last run is in the set before anything is judged."""
    os.makedirs(cache, exist_ok=True)
    rows, page = [], 1
    while True:
        path = os.path.join(cache, f"page_{page:03d}.json")
        if os.path.exists(path) and not refresh and page > FRESH_PAGES:
            d = json.load(open(path))
        else:
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(XANO_LIST + str(page), timeout=120) as r:
                        raw = r.read()
                    d = json.loads(raw)
                    open(path, "wb").write(raw)
                    break
                except Exception as e:  # noqa: BLE001
                    print(f"  page {page}: retry {attempt + 1} ({e})", file=sys.stderr)
                    time.sleep(3)
            else:
                raise SystemExit(f"could not fetch Xano page {page}")
        items = d.get("items", [])
        if not items:
            break
        rows.extend(items)
        if page % 10 == 0:
            print(f"  xano page {page}: {len(rows):,} rows so far", flush=True)
        if not d.get("nextPage"):
            break
        page += 1
    return rows


def fetch_supabase(url, key):
    """Every booking that came from Xano (legacy_id set)."""
    cols = ("id,legacy_id,legacy_reference,public_token,starts_at,status,voided_at,created_at,"
            "source_channel,pax_adult,pax_child,pax_infant,customer:customers(full_name)")
    rows, offset, step = [], 0, 1000
    while True:
        req = urllib.request.Request(
            f"{url}/rest/v1/bookings?select={cols}&legacy_id=not.is.null&order=starts_at.asc",
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Range": f"{offset}-{offset + step - 1}", "Range-Unit": "items"})
        with urllib.request.urlopen(req, timeout=120) as r:
            chunk = json.loads(r.read())
        rows.extend(chunk)
        if len(chunk) < step:
            return rows
        offset += step


def xano_identities(rows):
    keys, refs, tokens = set(), set(), set()
    for r in rows:
        ref = clean(r.get("booking_reference"))
        # The kiosk channel constant is not an identity (see xano-booking-sync).
        if ref and not ref.lower().startswith("kiosk-sale"):
            keys.add("ota-" + ref)
        for f in ("unique_id", "internal_id", "bookingConfirmation_id"):
            v = clean(r.get(f))
            if v:
                keys.add(v)
        keys.add(f"xano-{r['id']}")
        if ref:
            refs.add(ref)
        iid = clean(r.get("internal_id"))
        if iid:
            refs.add(iid)
        tok = clean(r.get("bookingConfirmation_id"))
        if tok:
            tokens.add(tok)
    return keys, refs, tokens


def pax(r):
    return (r["pax_adult"] or 0) + (r["pax_child"] or 0) + (r["pax_infant"] or 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="void the active ghosts")
    ap.add_argument("--refresh", action="store_true", help="re-download every Xano page")
    ap.add_argument("--cache", default=os.path.join(ROOT, ".reconcile-cache"))
    args = ap.parse_args()

    now = datetime.datetime.now(datetime.timezone.utc)
    reason = f"Deleted in the old system (reconciliation {now.date().isoformat()})"
    url, key = env_keys()

    # Supabase first, then Xano: a booking that reaches Xano between the two reads
    # is then in the Xano set (present) rather than only here (a false ghost).
    print("reading Supabase...")
    sb = fetch_supabase(url, key)
    print(f"supabase rows from Xano: {len(sb):,}")

    print("reading Xano (public listing, read-only)...")
    xano = fetch_xano(args.cache, args.refresh)
    ids = {r["id"] for r in xano}
    print(f"xano rows: {len(xano):,} (ids {min(ids)}..{max(ids)}; {max(ids) - len(ids):,} ids gone = deleted over time)")
    keys, refs, tokens = xano_identities(xano)
    # Nothing created here after the Xano read (less a margin) is judged at all.
    xano_read_ms = max(r.get("created_at") or 0 for r in xano)
    too_new = (datetime.datetime.fromtimestamp(xano_read_ms / 1000, datetime.timezone.utc)
               - datetime.timedelta(minutes=30)).isoformat()

    ghosts, matched, matched_2nd, skipped_new = [], 0, 0, 0
    for r in sb:
        if r["legacy_id"] in keys:
            matched += 1
        elif r.get("public_token") in tokens or r.get("legacy_reference") in refs:
            matched_2nd += 1
        elif (r.get("created_at") or "") >= too_new:
            skipped_new += 1
        else:
            ghosts.append(r)
    if skipped_new:
        print(f"skipped {skipped_new:,} rows created after the Xano read (judged next run)")
    active = [g for g in ghosts if g["status"] != "cancelled"]
    print(f"matched: {matched:,} by key, {matched_2nd:,} by token/reference; ghosts: {len(ghosts):,} "
          f"({len(ghosts) - len(active):,} already cancelled, {len(active):,} still counting, {sum(map(pax, active)):,} pax)")

    def when(r):
        d = datetime.datetime.fromisoformat(r["starts_at"].replace("Z", "+00:00"))
        if d < now - datetime.timedelta(days=30):
            return "past, older than 30 days"
        if d < now:
            return "past 30 days"
        if d < now + datetime.timedelta(days=7):
            return "NEXT 7 DAYS"
        return "further ahead"

    for title, fn in (("when the tour is", when),
                      ("source", lambda r: (r["source_channel"] or "").strip() or "(blank)"),
                      ("month of tour", lambda r: r["starts_at"][:7])):
        c, p = collections.Counter(), collections.Counter()
        for r in active:
            c[fn(r)] += 1
            p[fn(r)] += pax(r)
        print(f"\n--- active ghosts by {title} ---")
        for k, n in sorted(c.items(), key=lambda kv: -kv[1]):
            print(f"  {str(k):34s} {n:6,} bookings {p[k]:7,} pax")

    upcoming = sorted((g for g in active if when(g) in ("NEXT 7 DAYS", "further ahead")), key=lambda r: r["starts_at"])
    if upcoming:
        print("\n--- active ghosts with a FUTURE tour date (check these before --live) ---")
        for g in upcoming:
            print(f"  {g['starts_at'][:16]} {pax(g)} pax {(g.get('customer') or {}).get('full_name')!r:30s} "
                  f"{g['source_channel']!r:18s} {g['legacy_id']}")

    if not args.live:
        print("\nDRY RUN. Nothing written. Re-run with --live to void the active ghosts.")
        return

    stamp = now.isoformat()
    by_status = collections.defaultdict(list)
    for g in active:
        by_status[g["status"]].append(g["id"])
    done = 0
    for status, chunk_ids in by_status.items():
        for i in range(0, len(chunk_ids), 200):
            chunk = chunk_ids[i:i + 200]
            req = urllib.request.Request(
                f"{url}/rest/v1/bookings?id=in.({','.join(chunk)})&voided_at=is.null&status=eq.{status}",
                data=json.dumps({"status": "cancelled", "voided_at": stamp, "void_reason": reason,
                                 "voided_from_status": status}).encode(),
                method="PATCH",
                headers={"apikey": key, "Authorization": f"Bearer {key}",
                         "Content-Type": "application/json", "Prefer": "return=representation"})
            with urllib.request.urlopen(req, timeout=120) as r:
                done += len(json.load(r))
            print(f"  voided {done:,}/{len(active):,}", flush=True)
    print(f"LIVE: voided {done:,} ghost bookings with reason {reason!r}")


if __name__ == "__main__":
    main()
