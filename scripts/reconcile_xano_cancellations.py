#!/usr/bin/env python3
"""
Xano vs Supabase: bookings Xano CANCELLED that are still active here, voided to match.

Sibling of reconcile_xano_ghosts.py, which handles the other half of the same problem.
That one catches bookings Xano DELETED (the trigger sends an empty `$input.new`, so the
row lives on here). This one catches bookings Xano CANCELLED: the status change reaches
Bubble/Xano but does not reliably fire the booking trigger, so the row stays confirmed
here and keeps counting. Found 2026-09-10 while checking the owner's year-to-date
counter: 30 across 2026, almost all OTA (Viator, GetYourGuide, Civitatis), accumulating
at roughly ten a month.

Matching is deliberately stricter than the ghost script's. Only Xano's UNIQUE
identities count here (unique_id, internal_id, bookingConfirmation_id, xano-<id>), never
booking_reference: 201 Xano rows are each claimed by two of our rows through a shared
Bubble reference, and cancelling a live booking on a reference that belongs to somebody
else's row is not a mistake worth risking. Refusing those costs a handful of true
positives and is the right trade.

Xano is read-only throughout, through the same public listing the ghost script uses.
The void carries `x-sync-origin: xano` so the mirror trigger does not send the
cancellation back to Xano, which already has it (docs/xano-mirror.md).

Usage.
  python3 scripts/reconcile_xano_cancellations.py            # dry run, full report
  python3 scripts/reconcile_xano_cancellations.py --live     # void them
  python3 scripts/reconcile_xano_cancellations.py --year 2026  # default: every year
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


def fetch_page(page):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(XANO_LIST + str(page), timeout=120) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            print(f"  page {page}: retry {attempt + 1} ({e})", file=sys.stderr)
            time.sleep(3)
    raise SystemExit(f"could not fetch Xano page {page}")


def fetch_xano():
    """Every Xano booking. Read in full, id-descending, deduped by id."""
    rows, page = {}, 1
    while True:
        d = fetch_page(page)
        items = d.get("items", [])
        if not items:
            break
        for r in items:
            rows[r["id"]] = r
        if page % 20 == 0:
            print(f"  xano page {page}: {len(rows):,} rows so far", flush=True)
        if not d.get("nextPage"):
            break
        page += 1
    return list(rows.values())


def fetch_supabase(url, key):
    """Every booking here that is not already cancelled. Keyset paged on the id:
    offset paging over a non-unique column silently duplicates and skips rows."""
    cols = ("id,legacy_id,public_token,xano_internal_id,starts_at,status,source_channel,"
            "pax_adult,pax_child,pax_infant,customer:customers(full_name)")
    rows, last = [], None
    while True:
        after = f"&id=gt.{last}" if last else ""
        req = urllib.request.Request(
            f"{url}/rest/v1/bookings?select={cols}&status=neq.cancelled"
            f"&order=id.asc&limit=1000{after}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            chunk = json.loads(r.read())
        rows.extend(chunk)
        if len(chunk) < 1000:
            return rows
        last = chunk[-1]["id"]


def cancelled_index(xano):
    """Unique Xano identity -> row, for cancelled rows only. An identity claimed by
    two Xano rows is dropped: it no longer identifies anything."""
    seen, idx = set(), {}
    for r in xano:
        cancelled = (r.get("status") or "").strip().lower().startswith("cancel")
        for v in (clean(r.get("unique_id")), clean(r.get("internal_id")),
                  clean(r.get("bookingConfirmation_id")), f"xano-{r['id']}"):
            if not v:
                continue
            if v in seen:
                idx.pop(v, None)
                continue
            seen.add(v)
            if cancelled:
                idx[v] = r
    return idx


def pax(r):
    return (r["pax_adult"] or 0) + (r["pax_child"] or 0) + (r["pax_infant"] or 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="void the drifted bookings")
    ap.add_argument("--year", help="only tours departing in this year (default: all)")
    args = ap.parse_args()

    now = datetime.datetime.now(datetime.timezone.utc)
    reason = f"Cancelled in the old system (reconciliation {now.date().isoformat()})"
    url, key = env_keys()

    print("reading Supabase...")
    sb = fetch_supabase(url, key)
    print(f"active bookings here: {len(sb):,}")

    print("reading Xano (public listing, read-only)...")
    xano = fetch_xano()
    idx = cancelled_index(xano)
    print(f"xano rows: {len(xano):,}; unique identities of cancelled ones: {len(idx):,}")

    drifted = []
    for r in sb:
        if args.year and r["starts_at"][:4] != args.year:
            continue
        for c in (clean(r.get("xano_internal_id")), r.get("legacy_id"), r.get("public_token")):
            if c and c in idx:
                drifted.append((r, idx[c]))
                break

    print(f"\ncancelled in Xano, still active here: {len(drifted):,} "
          f"({sum(pax(r) for r, _ in drifted):,} pax)")
    if not drifted:
        return

    by_src = collections.Counter((r["source_channel"] or "(blank)") for r, _ in drifted)
    print("\n--- by source ---")
    for k, n in by_src.most_common():
        print(f"  {k:<24} {n:>4}")

    future = [(r, x) for r, x in drifted if r["starts_at"] > now.isoformat()]
    print(f"\n--- {len(future)} with a FUTURE tour date (check these before --live) ---")
    for r, x in sorted(future, key=lambda p: p[0]["starts_at"]):
        print(f"  {r['starts_at'][:16]}  {pax(r)} pax  "
              f"{(r.get('customer') or {}).get('full_name')!r:28} {r['source_channel']!r:16} "
              f"xano id={x['id']}")

    if not args.live:
        print("\nDRY RUN. Nothing written. Re-run with --live to void them.")
        return

    stamp = now.isoformat()
    by_status = collections.defaultdict(list)
    for r, _ in drifted:
        by_status[r["status"]].append(r["id"])
    done = 0
    for status, ids in by_status.items():
        for i in range(0, len(ids), 200):
            chunk = ids[i:i + 200]
            req = urllib.request.Request(
                f"{url}/rest/v1/bookings?id=in.({','.join(chunk)})"
                f"&voided_at=is.null&status=eq.{status}",
                data=json.dumps({"status": "cancelled", "voided_at": stamp,
                                 "void_reason": reason,
                                 "voided_from_status": status}).encode(),
                method="PATCH",
                # Xano cancelled these itself, so the void must not be mirrored back
                # to it: the origin header tells the trigger so (docs/xano-mirror.md).
                headers={"apikey": key, "Authorization": f"Bearer {key}",
                         "Content-Type": "application/json",
                         "Prefer": "return=representation",
                         "x-sync-origin": "xano"})
            with urllib.request.urlopen(req, timeout=120) as r:
                done += len(json.load(r))
            print(f"  voided {done:,}/{len(drifted):,}", flush=True)
    print(f"LIVE: voided {done:,} bookings with reason {reason!r}")


if __name__ == "__main__":
    main()
