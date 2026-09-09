#!/usr/bin/env python3
"""
Xano vs Supabase kiosk sales reconciliation: find sales one system has and the other
does not, and (with --live) import the ones only Xano has.

Why this exists. A kiosk sale is written to both stacks by two independent calls, and
neither waits for the other:

    tablet -> POST Xano cash_sales          (the old stack, still the tills' source)
    tablet -> POST kiosk-cash-sale          (here; fire-and-forget, never retried)

So either call can be the one that fails, and the sale then exists in one place only.
On the old card flow (kiosks.card_flow = 'v1') the tablet makes both calls itself, which
is where most of the loss is: 8 kiosk1 card sales went missing here between 2026-08-01
and 2026-09-03, roughly one a week, every one of them charged in Stripe. On card flow
v2 the SERVER writes both and retries the Xano side through kiosk-sale-sweep, so v2
kiosks lose card sales in neither direction. Cash still uses the tablet's own two calls
on every kiosk.

What it does.
  1. Reads Xano through the PUBLIC, read-only endpoint the tablet's own Sales screen
     uses, one call per kiosk per day:
         GET https://xmhi-aj9d-cnsb.n7.xano.io/api:_o9979qq/cash_sales?date=&kiosk=
     Xano is never written to. This script cannot write to Xano at all.
  2. Reads Supabase cash_sales for the same days with the service role key from
     .env.local (the key is never printed).
  3. Buckets both sides by (day, kiosk, tender, amount) and compares the counts. Times
     are not compared directly: the two writes are seconds apart and the day boundary
     is what each system files a sale under. Within a bucket the rows are lined up in
     time order, so the report names the actual unmatched sale, not just a count.
  4. Dry run prints both directions. With --live it inserts the XANO-ONLY sales here
     and nothing else. The other direction is reported, never acted on: we cannot
     write Xano, and deleting our own row would destroy the only record of a sale.

Why the two directions are not symmetrical. A sale we have and Xano does not is usually
deliberate, not a fault. Xano drops the sale row when a booking is cancelled and when a
card is refunded; we keep it, because the money really did change hands and a cancelled
booking is not the same thing as a cancelled sale. The report labels those so they can
be read past. What is left after the labels is the genuinely unexplained handful.

Imports are idempotent. Every imported row carries dedup_key = "xano-cash:<xano id>",
unique in the table, so a second run writes nothing. The tablet's own keys look like
"KS-ABC123:cash", so the two can never collide. This is the same key
scripts/xano_backfill_cash.py uses, so the two never double-import each other's rows.

Usage.
  python3 scripts/reconcile_kiosk_sales.py                      # last 7 days, dry run
  python3 scripts/reconcile_kiosk_sales.py --days 30            # a longer window
  python3 scripts/reconcile_kiosk_sales.py --from 2026-08-01 --to 2026-08-31
  python3 scripts/reconcile_kiosk_sales.py --days 30 --live     # import the Xano-only ones
"""
import argparse
import collections
import datetime
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

XANO_SALES = "https://xmhi-aj9d-cnsb.n7.xano.io/api:_o9979qq/cash_sales"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NY = ZoneInfo("America/New_York")
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def env_keys():
    env = {}
    for line in open(os.path.join(ROOT, ".env.local")):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    return env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_ROLE_KEY"]


def kiosk_map():
    """Xano's kiosk id -> this app's slug. Proven against overlapping sales, not guessed;
    the provenance is in the file itself. Never match on a prefix: kiosk3 and kiosk4
    differ only in the last three digits."""
    with open(os.path.join(ROOT, "scripts", "xano_kiosk_map.json")) as f:
        return json.load(f)["map"]


def cents(amount):
    """Xano stores the amount as text dollars ('40', '64.20'). Round through a string so
    64.20 cannot land on 6419."""
    try:
        return int(round(float(str(amount).replace("$", "").replace(",", "").strip()) * 100))
    except (TypeError, ValueError):
        return None


def tender(value):
    """Xano's type is inconsistent: 'cash', 'Cash', 'card', null. Null means cash, which
    is what the till's own screen assumes."""
    v = (value or "cash").strip().lower()
    return v if v in ("cash", "card") else "cash"


def xano_day(date, kiosk_id):
    """One day for one kiosk, the same call the tablet's Sales screen makes."""
    q = urllib.parse.urlencode({"date": f"{MONTHS[date.month - 1]} {date.day} {date.year}",
                                "kiosk": kiosk_id})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f"{XANO_SALES}?{q}", timeout=60) as r:
                data = json.loads(r.read())
            rows = data.get("sales", data) if isinstance(data, dict) else data
            return rows if isinstance(rows, list) else []
        except Exception as e:  # noqa: BLE001
            print(f"  {date} {kiosk_id[-4:]}: retry {attempt + 1} ({e})", file=sys.stderr)
            time.sleep(2)
    raise SystemExit(f"could not read Xano for {date}")


def fetch_xano(days, kiosks):
    rows = []
    for i, d in enumerate(days, 1):
        for kid, slug in kiosks.items():
            for r in xano_day(d, kid):
                if (r.get("status") or "success") != "success":
                    continue
                amt = cents(r.get("amount"))
                if amt is None:
                    continue
                ms = r.get("created_at")
                booking = r.get("booking_single") if isinstance(r.get("booking_single"), dict) else {}
                rows.append({
                    "xano_id": r.get("id"),
                    "day": str(d),
                    "kiosk": slug,
                    "type": tender(r.get("type")),
                    "cents": amt,
                    "ms": ms,
                    "at": datetime.datetime.fromtimestamp(ms / 1000, tz=NY) if ms else None,
                    "booking_id": r.get("booking_id"),
                    # The KS code of the booking this sale belongs to. Two Xano sale rows
                    # under one code are one sale written twice, whatever their row ids say.
                    "code": (booking.get("internal_id") or "").strip() or None,
                    "product": (r.get("product") or "ticket"),
                })
        if i % 5 == 0 or i == len(days):
            print(f"  xano: {i}/{len(days)} days, {len(rows):,} sales", flush=True)
    return rows


def fetch_supabase(url, key, lo, hi):
    """Our sales for the window. Keyset paged on the primary key: offset paging over a
    non-unique sort column is not stable across requests and silently skips rows."""
    cols = ("id,created_at,kiosk_slug,type,amount_cents,status,booking_ref,dedup_key,"
            "amount_refunded_cents,voided_at")
    rows, last = [], None
    while True:
        after = f"&id=gt.{last}" if last else ""
        q = (f"{url}/rest/v1/cash_sales?select={cols}&status=eq.success"
             f"&created_at=gte.{urllib.parse.quote(lo.isoformat())}"
             f"&created_at=lt.{urllib.parse.quote(hi.isoformat())}"
             f"&order=id.asc&limit=1000{after}")
        req = urllib.request.Request(q, headers={"apikey": key, "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            chunk = json.loads(r.read())
        rows.extend(chunk)
        if len(chunk) < 1000:
            break
        last = chunk[-1]["id"]
    out = []
    for r in rows:
        at = datetime.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00")).astimezone(NY)
        out.append({
            "id": r["id"],
            "day": str(at.date()),
            "at": at,
            "kiosk": r.get("kiosk_slug"),
            "type": (r.get("type") or "cash"),
            "cents": r.get("amount_cents") or 0,
            "ref": r.get("booking_ref"),
            "dedup_key": r.get("dedup_key"),
            "refunded": r.get("amount_refunded_cents") or 0,
            "voided": bool(r.get("voided_at")),
        })
    return out


def label_ours_only(url, key, rows):
    """Why a sale of ours is not in Xano. Xano drops the row when the booking is
    cancelled and when a card is refunded; we keep it on purpose, so those are expected
    and should not be chased. Anything unlabelled is a real one-sided write."""
    refs = sorted({r["ref"] for r in rows if r.get("ref")})
    status = {}
    for i in range(0, len(refs), 100):
        batch = refs[i:i + 100]
        inlist = ",".join(urllib.parse.quote(f'"{r}"') for r in batch)
        req = urllib.request.Request(
            f"{url}/rest/v1/bookings?select=legacy_id,status&legacy_id=in.({inlist})",
            headers={"apikey": key, "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=60) as r:
            for b in json.loads(r.read()):
                status[b["legacy_id"]] = b["status"]
    for r in rows:
        if r["voided"]:
            r["why"] = "voided here"
        elif r["refunded"]:
            r["why"] = "refunded"
        elif status.get(r.get("ref")) == "cancelled":
            r["why"] = "booking cancelled"
        else:
            r["why"] = "UNEXPLAINED"
    return rows


def kiosk_ids(url, key):
    req = urllib.request.Request(f"{url}/rest/v1/kiosks?select=id,slug,business_id",
                                 headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return {k["slug"]: k for k in json.loads(r.read())}


def live_from(xano, ours):
    """The first day each kiosk was actually writing here.

    Not the same as the first row we hold. A tablet was pointed at this stack one at a
    time, and before that day Xano is the only record, so EVERY sale reads as missing.
    Run over 2026-07-24..09-09 without this and it reports 938 missing sales worth
    $61,329, none of them lost: that is simply the history, and importing it belongs to
    scripts/xano_backfill_cash.py, which is bounded and staged for exactly that reason.

    A kiosk counts as live from the first day it recorded anything here and kept doing
    so. A single silent day inside the live period is NOT a cutover, it is an outage,
    and it stays in the report where someone can see it."""
    xdays = collections.defaultdict(set)
    for r in xano:
        xdays[r["kiosk"]].add(r["day"])
    odays = collections.defaultdict(set)
    for r in ours:
        odays[r["kiosk"]].add(r["day"])

    start = {}
    for kiosk, days in xdays.items():
        mine = odays.get(kiosk, set())
        # Walk forward past the leading run of days Xano sold on and we recorded none.
        for day in sorted(days):
            if day in mine:
                start[kiosk] = day
                break
    for kiosk in odays:
        if kiosk not in start:
            start[kiosk] = min(odays[kiosk])
    return start


def bucket(rows):
    b = collections.defaultdict(list)
    for r in rows:
        b[(r["day"], r["kiosk"], r["type"], r["cents"])].append(r)
    return b


def compare(xano, ours):
    """Line the two sides up bucket by bucket, pairing each sale with its closest twin
    in time.

    Within a bucket every sale is identical apart from its timestamp, so pairing by
    position would leave whichever row happened to fall last, not the one that is
    actually absent. The two writes land seconds apart, and a sale the other side never
    saw sits minutes or hours from anything, so nearest-in-time pairing names the row a
    person then has to go and look at. That is the whole point of the report."""
    xb, ob = bucket(xano), bucket(ours)
    xano_only, ours_only, xano_dupes = [], [], []
    for key in set(xb) | set(ob):
        xs = sorted(xb.get(key, []), key=lambda r: r["at"] or datetime.datetime.min)
        os_ = sorted(ob.get(key, []), key=lambda r: r["at"])
        # Two Xano rows for one booking are one sale written twice on the Xano side
        # (on 2026-09-09 the v2 completion and the sweep both mirrored KS-JFA37V4O,
        # 227 ms apart). They are not a sale we are missing, and importing the second
        # would double it here. Keep the first, report the rest.
        seen: set = set()
        kept = []
        for x in xs:
            # The booking's KS code, not Xano's row id: when the booking was written
            # twice as well, the two sale rows point at two different row ids.
            k = str(x.get("code") or x.get("booking_id") or "")
            if k and k in seen:
                xano_dupes.append(x)
                continue
            if k:
                seen.add(k)
            kept.append(x)
        xs = kept
        # Greedy over the closest pairs first, so one outlier cannot drag the whole
        # bucket out of step behind it.
        pairs = sorted(
            ((abs((x["at"] - o["at"]).total_seconds()), i, j)
             for i, x in enumerate(xs) if x["at"]
             for j, o in enumerate(os_)),
            key=lambda t: t[0])
        used_x, used_o = set(), set()
        for _, i, j in pairs:
            if i not in used_x and j not in used_o:
                used_x.add(i)
                used_o.add(j)
        xano_only.extend(x for i, x in enumerate(xs) if i not in used_x)
        ours_only.extend(o for j, o in enumerate(os_) if j not in used_o)
    xano_only.sort(key=lambda r: (r["day"], r["kiosk"]))
    ours_only.sort(key=lambda r: r["at"])
    xano_dupes.sort(key=lambda r: (r["day"], r["kiosk"]))
    return xano_only, ours_only, xano_dupes


def resolve_refs(url, key, rows):
    """Give each missing CARD sale our own booking reference instead of Xano's number.

    Xano points at a booking by a numeric id this stack does not carry, so importing
    that verbatim leaves a row that joins to nothing: no customer name on the payments
    screen, and the refund mirror in _shared/sale-refund.ts keys on booking_ref, so a
    later refund would never find it. The charge is the bridge. Every one of these was
    taken by card, so Stripe holds a row with the same kiosk and amount within seconds
    of Xano's, carrying the KS code we use everywhere.

    Cash has no such bridge and keeps Xano's number, which is still better than null.

    A charge's `source` is usually the slug the tablet stamps, but a sale that reached
    Stripe by some other path carries Xano's raw kiosk id instead (B36SCU on 2026-09-03
    is one). Both spellings are accepted, or the very rows this is here to rescue would
    be the ones it could not name."""
    aliases = {slug: {slug, xid} for xid, slug in kiosk_map().items()}
    cards = [r for r in rows if r["type"] == "card" and r.get("at")]
    if not cards:
        return
    lo = min(r["at"] for r in cards) - datetime.timedelta(minutes=10)
    hi = max(r["at"] for r in cards) + datetime.timedelta(minutes=10)
    q = (f"{url}/rest/v1/stripe_transactions?select=created_at,amount,source,booking_ref"
         f"&created_at=gte.{urllib.parse.quote(lo.isoformat())}"
         f"&created_at=lt.{urllib.parse.quote(hi.isoformat())}&limit=5000")
    req = urllib.request.Request(q, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        charges = json.loads(r.read())
    for c in charges:
        c["at"] = datetime.datetime.fromisoformat(c["created_at"].replace("Z", "+00:00")).astimezone(NY)

    for sale in cards:
        best, best_gap = None, datetime.timedelta(minutes=5)
        for c in charges:
            if c.get("amount") != sale["cents"]:
                continue
            if c.get("source") not in aliases.get(sale["kiosk"], {sale["kiosk"]}):
                continue
            gap = abs(c["at"] - sale["at"])
            if gap < best_gap:
                best, best_gap = c, gap
        if best and best.get("booking_ref"):
            sale["ref"] = best["booking_ref"]


def insert_missing(url, key, rows, kiosks, live):
    """Import the sales only Xano has. Idempotent on dedup_key, so a re-run is a no-op.
    booking_id is left null: it is a Supabase uuid and these rows are matched by
    reference, which is how the tablet's own writes arrive too."""
    resolve_refs(url, key, rows)
    payload = []
    for r in rows:
        k = kiosks.get(r["kiosk"])
        if not k:
            print(f"  skip: no kiosk row for {r['kiosk']}", file=sys.stderr)
            continue
        ref = r.get("ref") or (str(r["booking_id"]) if r.get("booking_id") else None)
        payload.append({
            "business_id": k["business_id"],
            "kiosk_id": k["id"],
            "kiosk_slug": r["kiosk"],
            "booking_ref": ref,
            "amount_cents": r["cents"],
            "type": r["type"],
            "product": r["product"],
            "status": "success",
            "source": "kiosk",
            "dedup_key": f"xano-cash:{r['xano_id']}",
            "created_at": r["at"].astimezone(datetime.timezone.utc).isoformat() if r.get("at") else None,
        })
    if not payload:
        return 0
    if not live:
        return len(payload)
    done = 0
    for i in range(0, len(payload), 200):
        batch = payload[i:i + 200]
        req = urllib.request.Request(
            f"{url}/rest/v1/cash_sales?on_conflict=dedup_key",
            data=json.dumps(batch).encode(),
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Content-Type": "application/json",
                     "Prefer": "resolution=ignore-duplicates,return=minimal"},
            method="POST")
        with urllib.request.urlopen(req, timeout=120):
            done += len(batch)
    return done


def money(c):
    return f"${c / 100:,.2f}"


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--days", type=int, default=7, help="how many days back from today (default 7)")
    p.add_argument("--from", dest="frm", help="first day, YYYY-MM-DD (overrides --days)")
    p.add_argument("--to", dest="to", help="last day, YYYY-MM-DD (defaults to today)")
    p.add_argument("--live", action="store_true",
                   help="import the sales only Xano has. Xano is never written to.")
    args = p.parse_args()

    today = datetime.datetime.now(NY).date()
    if args.frm:
        lo_d = datetime.date.fromisoformat(args.frm)
        hi_d = datetime.date.fromisoformat(args.to) if args.to else today
    else:
        hi_d = today
        lo_d = today - datetime.timedelta(days=args.days - 1)
    days = [lo_d + datetime.timedelta(days=i) for i in range((hi_d - lo_d).days + 1)]

    url, key = env_keys()
    kiosks = kiosk_map()
    print(f"Reconciling {lo_d} .. {hi_d}  ({len(days)} days, {len(kiosks)} kiosks)\n")

    # Ours first, Xano second. A sale made between the two reads then shows up as
    # Xano-only, which is the harmless direction: the importer's dedup key means the
    # tablet's own write and this one cannot both land.
    lo = datetime.datetime(lo_d.year, lo_d.month, lo_d.day, tzinfo=NY)
    hi = datetime.datetime(hi_d.year, hi_d.month, hi_d.day, tzinfo=NY) + datetime.timedelta(days=1)
    ours = fetch_supabase(url, key, lo, hi)
    print(f"  here: {len(ours):,} sales")
    xano = fetch_xano(days, kiosks)

    # Days before a kiosk was pointed at this stack are not a disagreement, they are
    # history, and importing them is xano_backfill_cash.py's job, not this one's.
    start = live_from(xano, ours)
    held = [r for r in xano if r["day"] < start.get(r["kiosk"], "9999")]
    if held:
        xano = [r for r in xano if r["day"] >= start.get(r["kiosk"], "9999")]
        by = collections.Counter(r["kiosk"] for r in held)
        print("\n  before these kiosks wrote here, left alone:")
        for k in sorted(by):
            print(f"    {k}: {by[k]:,} Xano sales before {start.get(k, '?')}")
        print("    (that is history, not loss. Use scripts/xano_backfill_cash.py for it.)")

    xano_only, ours_only, xano_dupes = compare(xano, ours)
    print(f"\nXano {len(xano):,} sales   here {len(ours):,} sales   (comparable window)")

    if xano_dupes:
        print(f"\nXANO DUPLICATES: {len(xano_dupes)} sales Xano holds twice, {money(sum(r['cents'] for r in xano_dupes))}")
        print("  (one sale written to Xano twice. Not missing here, and never imported.)")
        print(f"  {'day':11} {'kiosk':7} {'tender':6} {'amount':>10}  code          xano id")
        for r in xano_dupes:
            print(f"  {r['day']:11} {r['kiosk']:7} {r['type']:6} {money(r['cents']):>10}  "
                  f"{(r.get('code') or '-'):13} {r['xano_id']}")

    if not xano_only and not ours_only:
        print("\nEvery sale matches on both sides.")
        return

    if xano_only:
        total = sum(r["cents"] for r in xano_only)
        resolve_refs(url, key, xano_only)
        print(f"\nMISSING HERE: {len(xano_only)} sales, {money(total)}")
        print(f"  {'day':11} {'kiosk':7} {'tender':6} {'amount':>10}  reference     xano id")
        for r in xano_only:
            ref = r.get("ref") or f"(xano {r.get('booking_id')})"
            print(f"  {r['day']:11} {r['kiosk']:7} {r['type']:6} {money(r['cents']):>10}  "
                  f"{ref:13} {r['xano_id']}")

    if ours_only:
        ours_only = label_ours_only(url, key, ours_only)
        expected = [r for r in ours_only if r["why"] != "UNEXPLAINED"]
        unknown = [r for r in ours_only if r["why"] == "UNEXPLAINED"]
        print(f"\nNOT IN XANO: {len(ours_only)} sales, {money(sum(r['cents'] for r in ours_only))}")
        print("  (reported only. Xano is never written to, and deleting our row would")
        print("   destroy the only record of a sale.)")
        if expected:
            by = collections.Counter(r["why"] for r in expected)
            print("  expected: " + ", ".join(f"{n} {w}" for w, n in by.most_common()))
        if unknown:
            print(f"\n  UNEXPLAINED: {len(unknown)} sales, {money(sum(r['cents'] for r in unknown))}")
            print(f"  {'day':11} {'kiosk':7} {'tender':6} {'amount':>10}  reference")
            for r in unknown:
                print(f"  {r['day']:11} {r['kiosk']:7} {r['type']:6} "
                      f"{money(r['cents']):>10}  {r['ref'] or '-'}")

    if xano_only:
        live_kiosks = kiosk_ids(url, key)
        n = insert_missing(url, key, xano_only, live_kiosks, args.live)
        if args.live:
            print(f"\nImported {n} sales. Re-run to confirm the two sides now agree.")
        else:
            print(f"\nDry run. {n} sales would be imported here. Re-run with --live to do it.")


if __name__ == "__main__":
    main()
