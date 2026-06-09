#!/usr/bin/env python3
"""
Import legacy bookings CSV into Supabase staging/mapping tables.

Key behavior:
- Uses bookings.product as the authoritative legacy product ID.
- Intentionally ignores bookings.products_variation_id.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def parse_env_file(path: Path) -> dict[str, str]:
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


def normalize_text(value: str | None) -> str:
    if value is None:
        return ""
    cleaned = value.replace("\u00a0", " ").strip().lower()
    return re.sub(r"[^a-z0-9]+", "", cleaned)


def parse_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def chunked(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def http_json(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: Any = None,
    query: dict[str, str] | None = None,
    apikey: str,
    access_token: str | None = None,
    prefer: str | None = None,
) -> Any:
    q = ""
    if query:
        q = "?" + urllib.parse.urlencode(query)
    url = f"{base_url.rstrip('/')}{path}{q}"

    headers = {
        "apikey": apikey,
        "Content-Type": "application/json",
    }
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    if prefer:
        headers["Prefer"] = prefer

    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            if not raw:
                return None
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as err:
        error_body = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed ({err.code}): {error_body}") from err


def build_product_lookup(products: list[dict[str, Any]]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for product in products:
        product_id = product["id"]
        for candidate in [
            product.get("product_name"),
            product.get("short_name"),
        ]:
            key = normalize_text(candidate)
            if key:
                lookup[key] = product_id

        name_variations = product.get("name_variations") or []
        if isinstance(name_variations, list):
            for variation in name_variations:
                key = normalize_text(variation)
                if key:
                    lookup[key] = product_id
    return lookup


def map_products(
    *,
    bookings_rows: list[dict[str, str]],
    product_rows: list[dict[str, str]],
    product_lookup: dict[str, str],
) -> tuple[dict[str, dict[str, str]], list[str]]:
    mapped: dict[str, dict[str, str]] = {}

    # 1) Use products variation table first (internal_id -> product_name/short_name)
    for row in product_rows:
        old_id = (row.get("internal_id") or "").strip()
        if not old_id:
            continue
        product_name = (row.get("product_name") or "").strip()
        short_name = (row.get("short_name") or "").strip()

        product_id = product_lookup.get(normalize_text(product_name))
        method = "products_csv_product_name"
        if not product_id and short_name:
            product_id = product_lookup.get(normalize_text(short_name))
            method = "products_csv_short_name"

        if product_id:
            mapped[old_id] = {
                "new_product_id": product_id,
                "old_product_name": product_name,
                "match_method": method,
            }

    # 2) Fallback using bookings.product_var distribution by old product ID
    product_var_counts: dict[str, Counter[str]] = defaultdict(Counter)
    for row in bookings_rows:
        old_id = (row.get("product") or "").strip()
        product_var = (row.get("product_var") or "").strip()
        if old_id and product_var:
            product_var_counts[old_id][product_var] += 1

    all_old_ids = sorted({(row.get("product") or "").strip() for row in bookings_rows if (row.get("product") or "").strip()})
    unmapped: list[str] = []
    for old_id in all_old_ids:
        if old_id in mapped:
            continue
        top_names = product_var_counts.get(old_id, Counter()).most_common(10)
        found = False
        for candidate, _ in top_names:
            product_id = product_lookup.get(normalize_text(candidate))
            if product_id:
                mapped[old_id] = {
                    "new_product_id": product_id,
                    "old_product_name": candidate,
                    "match_method": "bookings_product_var",
                }
                found = True
                break
        if not found:
            unmapped.append(old_id)

    return mapped, unmapped


def main() -> int:
    parser = argparse.ArgumentParser(description="Import legacy bookings CSV into Supabase.")
    parser.add_argument("--bookings-csv", required=True, type=Path)
    parser.add_argument("--products-csv", required=True, type=Path)
    parser.add_argument("--source-system", default="legacy")
    parser.add_argument("--import-batch", default=f"legacy_{int(time.time())}")
    parser.add_argument("--company-id", default="")
    parser.add_argument("--email", default=os.environ.get("PWC_IMPORT_EMAIL", ""))
    parser.add_argument("--password", default=os.environ.get("PWC_IMPORT_PASSWORD", ""))
    parser.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args()

    if not args.email or not args.password:
        raise SystemExit("Missing credentials. Set --email/--password or PWC_IMPORT_EMAIL/PWC_IMPORT_PASSWORD.")

    env = parse_env_file(Path(".env.local"))
    supabase_url = env.get("NEXT_PUBLIC_SUPABASE_URL", "")
    anon_key = env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")
    if not supabase_url or not anon_key:
        raise SystemExit("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local")

    bookings_rows = parse_csv(args.bookings_csv)
    product_rows = parse_csv(args.products_csv)
    print(json.dumps({"bookings_rows": len(bookings_rows), "products_rows": len(product_rows)}))

    auth = http_json(
        supabase_url,
        "/auth/v1/token",
        method="POST",
        query={"grant_type": "password"},
        payload={"email": args.email, "password": args.password},
        apikey=anon_key,
    )
    access_token = auth.get("access_token")
    if not access_token:
        raise SystemExit("Could not authenticate user for import.")

    company_id = args.company_id.strip()
    if not company_id:
        companies = http_json(
            supabase_url,
            "/rest/v1/companies",
            method="GET",
            query={"select": "id,name,email", "order": "created_at.asc", "limit": "1"},
            apikey=anon_key,
            access_token=access_token,
        )
        if not companies:
            raise SystemExit("No companies found for this user.")
        company_id = companies[0]["id"]
    print(json.dumps({"company_id": company_id, "source_system": args.source_system, "import_batch": args.import_batch}))

    products = http_json(
        supabase_url,
        "/rest/v1/products",
        method="GET",
        query={
            "select": "id,product_name,short_name,name_variations,company_id",
            "company_id": f"eq.{company_id}",
            "limit": "1000",
        },
        apikey=anon_key,
        access_token=access_token,
    )
    product_lookup = build_product_lookup(products)
    mapped_products, unmapped_products = map_products(
        bookings_rows=bookings_rows,
        product_rows=product_rows,
        product_lookup=product_lookup,
    )

    # Upsert product mappings first
    mapping_payload = []
    for old_product_id, item in mapped_products.items():
        mapping_payload.append(
            {
                "company_id": company_id,
                "source_system": args.source_system,
                "old_product_id": old_product_id,
                "old_product_name": item["old_product_name"],
                "new_product_id": item["new_product_id"],
                "match_method": item["match_method"],
            }
        )

    if mapping_payload:
        http_json(
            supabase_url,
            "/rest/v1/product_id_map",
            method="POST",
            query={"on_conflict": "company_id,source_system,old_product_id"},
            payload=mapping_payload,
            apikey=anon_key,
            access_token=access_token,
            prefer="resolution=merge-duplicates,return=minimal",
        )

    # Stage bookings rows (ignore products_variation_id by design)
    staged_payload: list[dict[str, Any]] = []
    for row in bookings_rows:
        old_product_id = (row.get("product") or "").strip()
        inferred_old_name = ""
        if old_product_id in mapped_products:
            inferred_old_name = mapped_products[old_product_id]["old_product_name"]
        if not inferred_old_name:
            inferred_old_name = (row.get("product_var") or "").strip()

        staged_payload.append(
            {
                "company_id": company_id,
                "source_system": args.source_system,
                "import_batch": args.import_batch,
                "old_booking_id": (row.get("id") or "").strip(),
                "old_product_id": old_product_id,
                "old_product_name": inferred_old_name,
                "old_customer_id": (row.get("contactID") or "").strip(),
                "customer_email": (row.get("email") or "").strip(),
                "customer_first_name": (row.get("Fname") or "").strip(),
                "customer_last_name": (row.get("Lname") or "").strip(),
                "customer_phone": (row.get("phone") or "").strip(),
                "customer_country": "",
                "adult": (row.get("adult") or "").strip(),
                "booking_channel": (row.get("booking_channel") or "").strip(),
                "booking_reference": (row.get("booking_reference") or "").strip(),
                "checked": (row.get("checked") or "").strip(),
                "child": (row.get("child") or "").strip(),
                "infant": (row.get("infant") or "").strip(),
                "paxs": (row.get("paxs") or "").strip(),
                "date_timestamp": (row.get("date_timestamp") or "").strip(),
                "check_in_time": (row.get("check_in_time") or "").strip(),
                "internal_id": (row.get("internal_id") or "").strip(),
                "status": (row.get("status") or "").strip(),
                "supplier": (row.get("supplier") or "").strip(),
                "note": (row.get("note") or "").strip(),
                "product_var": (row.get("product_var") or "").strip(),
                "peek": (row.get("peek") or "").strip(),
                "price": (row.get("price") or "").strip(),
                "raw_record": row,
            }
        )

    # Clear same batch before reloading (idempotent reruns)
    http_json(
        supabase_url,
        "/rest/v1/stg_bookings_raw",
        method="DELETE",
        query={
            "company_id": f"eq.{company_id}",
            "source_system": f"eq.{args.source_system}",
            "import_batch": f"eq.{args.import_batch}",
        },
        apikey=anon_key,
        access_token=access_token,
        prefer="return=minimal",
    )

    for batch in chunked(staged_payload, args.batch_size):
        http_json(
            supabase_url,
            "/rest/v1/stg_bookings_raw",
            method="POST",
            payload=batch,
            apikey=anon_key,
            access_token=access_token,
            prefer="return=minimal",
        )

    backfill_result = http_json(
        supabase_url,
        "/rest/v1/rpc/backfill_product_id_map_from_names",
        method="POST",
        payload={"p_company_id": company_id, "p_source_system": args.source_system},
        apikey=anon_key,
        access_token=access_token,
    )

    customers_result = http_json(
        supabase_url,
        "/rest/v1/rpc/migrate_legacy_customers",
        method="POST",
        payload={"p_company_id": company_id, "p_source_system": args.source_system},
        apikey=anon_key,
        access_token=access_token,
    )

    bookings_result = http_json(
        supabase_url,
        "/rest/v1/rpc/migrate_legacy_bookings",
        method="POST",
        payload={"p_company_id": company_id, "p_source_system": args.source_system},
        apikey=anon_key,
        access_token=access_token,
    )

    # Pull unresolved product IDs for follow-up
    unmapped_view = http_json(
        supabase_url,
        "/rest/v1/v_legacy_unmapped_products",
        method="GET",
        query={
            "select": "old_product_id,old_product_name,booking_rows",
            "company_id": f"eq.{company_id}",
            "source_system": f"eq.{args.source_system}",
            "order": "booking_rows.desc",
        },
        apikey=anon_key,
        access_token=access_token,
    )

    print(
        json.dumps(
            {
                "mapped_products_count": len(mapping_payload),
                "unmapped_products_from_csv_heuristic": unmapped_products,
                "staged_rows": len(staged_payload),
                "backfill_result": backfill_result,
                "customers_result": customers_result,
                "bookings_result": bookings_result,
                "unmapped_products_view": unmapped_view,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
