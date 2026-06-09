#!/usr/bin/env python3
"""
Import the Xano `bookings` CSV export into Supabase.

Two steps:
  stage      CSV rows -> bookings_legacy_raw (untouched copy, for debugging/re-runs)
  transform  CSV rows -> customers (deduped) + bookings (mapped to the new schema)

Safety: this only writes to Supabase. It never touches Xano. Editing a booking
in the app later does not flow back anywhere; this is a one-way snapshot.

Idempotent: bookings upsert on legacy_id. Use --reset to clear prior imported
rows first (bookings + xano-sourced customers) for a clean full load.

Usage:
  python3 scripts/import_xano_bookings.py stage      [--limit N]
  python3 scripts/import_xano_bookings.py transform  [--reset] [--limit N]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "dbo-bookings-64-live.1780500168.csv"
ENV_PATH = ROOT / ".env.local"
BATCH = 500


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


ENV = load_env()
BASE = ENV["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
KEY = ENV["SUPABASE_SERVICE_ROLE_KEY"]


def rest(method: str, path: str, *, body=None, prefer: str | None = None, query: str = ""):
    url = f"{BASE}/rest/v1/{path}{query}"
    headers = {
        "apikey": KEY,
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    last = None
    for attempt in range(6):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")
            # 4xx is a real error (bad data); do not retry. 5xx may be transient.
            if e.code < 500:
                raise RuntimeError(f"{method} {path} -> {e.code}: {msg}") from e
            last = RuntimeError(f"{method} {path} -> {e.code}: {msg}")
        except Exception as e:  # ssl/socket/url transient errors
            last = e
        time.sleep(1.5 * (attempt + 1))
    raise last if last else RuntimeError(f"{method} {path} failed")


def norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def clean(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    return None if v == "" or v.lower() == "null" else v


def read_csv(limit: int | None):
    with CSV_PATH.open(encoding="utf-8-sig", newline="") as f:
        for i, row in enumerate(csv.DictReader(f)):
            if limit is not None and i >= limit:
                break
            yield row


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


# ── Mapping basis (fetched live from Supabase) ────────────────────────────────

def fetch_tour_map():
    rows = rest("GET", "business_tours",
                query="?select=id,name,legacy_product_id,business_id")
    by_product: dict[str, dict] = {}
    by_name: dict[str, dict] = {}
    for r in rows:
        rec = {"business_tour_id": r["id"], "business_id": r["business_id"]}
        if r.get("legacy_product_id"):
            by_product[r["legacy_product_id"]] = rec
        by_name[norm(r["name"])] = rec
    return by_product, by_name


# Curated aliases discovered from the data: messy supplier/channel names -> tour name.
ALIASES = {
    # boat tour brand variants -> the Skyline cruise
    "miamiskylinecruises": "miamiskylinecruises",
    "miamistarislandcruises": "miamiskylinecruises",
    "starislandcruises": "miamiskylinecruises",
    "miamisunsetboatcruises": "miamiskylinecruises",
    "miamisunsetboat": "miamiskylinecruises",
    "miamibaysideboattour": "miamiskylinecruises",
    "miamibaysideboattourwebsite": "miamiskylinecruises",
    "miamicelebrityboattours": "miamiskylinecruises",
    "miamiboattours": "miamiskylinecruises",
    "miamisightseeingboattours": "miamiskylinecruises",
    "miamistarisland": "miamiskylinecruises",
    # city tour
    "miamitourbus": "miami5in1citytour",
    # key west
    "keywestsightseeingtours": "keywestdaytrips",
    "keywest": "keywestdaytrips",
}
# company (Bubble id) -> flagship tour name, last-resort fallback
COMPANY_DEFAULT = {
    "1712894857551x926333421634977800": "miamiskylinecruises",
    "1712896100693x988159247184035800": "keywestdaytrips",
}
DEFAULT_TOUR_NAME = "miamiskylinecruises"  # if even company is unknown


def resolve_tour(row, by_product, by_name):
    """Return (rec, method) where rec has business_tour_id + business_id."""
    p = clean(row.get("product"))
    if p and p in by_product:
        return by_product[p], "product_id"
    for field in ("supplier", "booking_channel"):
        key = norm(row.get(field))
        if key in by_name:
            return by_name[key], "name"
        if key in ALIASES and ALIASES[key] in by_name:
            return by_name[ALIASES[key]], "alias"
    comp = clean(row.get("company"))
    tgt = COMPANY_DEFAULT.get(comp or "", DEFAULT_TOUR_NAME)
    return by_name[tgt], "company_default"


# ── Field conversions ─────────────────────────────────────────────────────────

def parse_name(row) -> str:
    cn = clean(row.get("customer_name"))
    if cn:
        if "," in cn:
            last, first = cn.split(",", 1)
            full = f"{first.strip()} {last.strip()}".strip()
            if full:
                return full
        return cn
    parts = [clean(row.get("Fname")), clean(row.get("Lname"))]
    full = " ".join(p for p in parts if p)
    return full or "Guest"


def to_int(v) -> int:
    try:
        return max(0, int(float(v)))
    except (TypeError, ValueError):
        return 0


def epoch_iso(ms: str | None) -> str | None:
    ms = clean(ms)
    if not ms:
        return None
    try:
        return dt.datetime.fromtimestamp(int(float(ms)) / 1000, tz=dt.timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def starts_at_of(row) -> str | None:
    iso = epoch_iso(row.get("date_timestamp"))
    if iso:
        return iso
    d = clean(row.get("date"))
    if d and re.match(r"^\d{4}-\d{2}-\d{2}$", d):
        return f"{d}T12:00:00+00:00"
    return None


STATUS_MAP = {"confirmed": "confirmed", "canceled": "cancelled",
              "cancelled": "cancelled", "pending": "pending"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["stage", "transform"])
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()

    if args.step == "stage":
        rows = [{"row": r} for r in read_csv(args.limit)]
        print(f"staging {len(rows)} rows -> bookings_legacy_raw")
        for i, ch in enumerate(chunks(rows, BATCH)):
            rest("POST", "bookings_legacy_raw", body=ch, prefer="return=minimal")
            print(f"  staged {min((i+1)*BATCH, len(rows))}/{len(rows)}", end="\r")
        print("\ndone.")
        return

    # transform
    by_product, by_name = fetch_tour_map()
    print(f"loaded {len(by_product)} product ids, {len(by_name)} tour names")

    if args.reset:
        print("resetting: deleting existing bookings + xano customers")
        rest("DELETE", "bookings", query="?legacy_id=not.is.null", prefer="return=minimal")
        rest("DELETE", "customers", query="?legacy_source=eq.xano", prefer="return=minimal")

    # Pass 1: build deduped customers + booking specs.
    cust_key_to_idx: dict[tuple, int] = {}
    customers: list[dict] = []
    specs: list[dict] = []  # booking payloads minus customer_id; carry cust key
    method_counts: dict[str, int] = {}
    skipped = 0

    for row in read_csv(args.limit):
        starts = starts_at_of(row)
        if not starts:
            skipped += 1
            continue
        rec, method = resolve_tour(row, by_product, by_name)
        method_counts[method] = method_counts.get(method, 0) + 1
        business_id = rec["business_id"]

        name = parse_name(row)
        phone = clean(row.get("phone"))
        email = clean(row.get("email"))
        # Dedup customers within a business conservatively: only merge bookings
        # that share BOTH phone and name. Email is intentionally not a dedup key
        # because OTA channels reuse one inbox across many distinct guests.
        ckey = (business_id, norm(phone), norm(name))
        if ckey not in cust_key_to_idx:
            cust_key_to_idx[ckey] = len(customers)
            customers.append({
                "business_id": business_id,
                "full_name": name,
                "phone": phone,
                "email": email,
                "legacy_source": "xano",
            })

        a, c, inf = to_int(row.get("adult")), to_int(row.get("child")), to_int(row.get("infant"))
        if a + c + inf == 0:
            a = to_int(row.get("paxs"))
        start_dt = dt.datetime.fromisoformat(starts)
        ends = (start_dt + dt.timedelta(minutes=90)).isoformat()
        checked = clean(row.get("checked")) == "1"
        checked_at = None
        if checked:
            checked_at = epoch_iso(row.get("check_in_time")) or starts
        price = clean(row.get("price"))
        total_cents = 0
        if price:
            try:
                total_cents = round(float(price) * 100)
            except ValueError:
                total_cents = 0
        legacy_id = clean(row.get("unique_id")) or f"xano-{clean(row.get('id'))}"
        status = STATUS_MAP.get((clean(row.get("status")) or "").lower(), "confirmed")

        specs.append({
            "_ckey": ckey,
            "business_id": business_id,
            "business_tour_id": rec["business_tour_id"],
            "starts_at": starts,
            "ends_at": ends,
            "status": status,
            "total_cents": total_cents,
            "currency": "usd",
            "pax_adult": a, "pax_child": c, "pax_infant": inf,
            "tour_pax_breakdown": [],
            "checked_in_at": checked_at,
            "legacy_id": legacy_id,
            "legacy_reference": clean(row.get("booking_reference")),
            "source_channel": clean(row.get("booking_channel")),
        })

    print(f"prepared {len(customers)} customers, {len(specs)} bookings, skipped {skipped}")
    print("match methods:", method_counts)

    # Insert customers, capturing ids in insertion order.
    cust_ids: list[str] = []
    for ch in chunks(customers, BATCH):
        res = rest("POST", "customers", body=ch, prefer="return=representation")
        cust_ids.extend(r["id"] for r in res)
        print(f"  customers {len(cust_ids)}/{len(customers)}", end="\r")
    print()
    idx_to_id = {i: cust_ids[i] for i in range(len(cust_ids))}

    # Attach customer ids and insert bookings (upsert on legacy_id).
    payloads = []
    for s in specs:
        cid = idx_to_id[cust_key_to_idx[s.pop("_ckey")]]
        s["customer_id"] = cid
        payloads.append(s)
    done = 0
    for ch in chunks(payloads, BATCH):
        rest("POST", "bookings",
             body=ch, prefer="return=minimal,resolution=merge-duplicates",
             query="?on_conflict=legacy_id")
        done += len(ch)
        print(f"  bookings {done}/{len(payloads)}", end="\r")
    print("\ndone.")


if __name__ == "__main__":
    main()
