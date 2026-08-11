# Groupon `/gp` shadow test

Grades the Supabase voucher matcher against live Xano, on real customer vouchers,
until we trust it enough to cut `/gp` over.

**Xano is never written to.** The test only calls `gp-voucher-vision`, the
read-only half of the flow. No bookings, no customers, no Stripe.

## Why

The Supabase matcher and Xano's `vision_v4` disagree in both directions, and both
directions cost money:

- Xano rejects vouchers we handle. Its scorer gives the "Homes of the Rich &
  Famous" deal 0.33 to 0.37 against its own 0.45 threshold, so live `/gp` turns
  those customers away today.
- We matched a voucher Xano rejected correctly: "Skyline & Coast Cruise" sold by
  *N.Y.C Skyline Tours & Cruises*, a New York operator with no relationship to
  Prime. That would have booked a Miami tour and charged the fee. It is what the
  merchant gate now exists to stop.

Neither was predictable from reading code. Both came out of replaying real
traffic, which is the whole argument for keeping this running.

## Shape

```
Xano vision_v4  --(voucher image + its verdict)-->  gp-shadow-compare
                                                          |
                                            gp-voucher-vision (ours)
                                                          |
                                                   gp_shadow_runs
                                                          |
                                                 /admin/gp-shadow
```

- **`gp_shadow_runs`** — one row per voucher: Xano's verdict, ours, and a
  `verdict` classifying the pair. Owner-only RLS; the function writes with the
  service role. Migration `20260812090000_gp_shadow_runs.sql`.
- **`gp_shadow_summary(from, to)`** — counts aggregated in the database. The
  table grows without bound and a single read caps at 1000 rows, so the page
  never sums in JS.
- **`gp-shadow-compare`** edge function — takes one voucher, copies the image
  into the `gp-vouchers` bucket (the vision function only accepts URLs from
  there), runs our matcher, classifies, inserts. Idempotent on `xano_ref`, so
  Xano may retry and a replay may be re-run without duplicating rows.
- **`/admin/gp-shadow`** — owner-only. Agreement rate, how the matches were
  reached, and every non-agreement to review.

### Verdicts

| verdict | meaning |
| --- | --- |
| `agree` | both picked the same product |
| `different_product` | both picked, and they disagree. **The one that matters.** |
| `ours_only` | we matched, Xano did not. Usually Xano being wrong |
| `xano_only` | Xano matched, we did not. Usually a missing alias on our side |
| `both_none` | neither matched. Usually another operator's voucher |
| `error` | the replay itself failed |

Agreement on the page is `agree / (agree + different_product)`: only the vouchers
where both systems committed to a product. Counting "Xano did not match" as a
disagreement would score us down for the cases we handle and Xano does not.

## Feeding it

The Supabase side is built and deployed. It needs vouchers pushed to it, and
that is the one piece that touches Xano.

**Add to `vision_v4`'s existing `util.post_process` block** (the one that already
writes the `multimedia` row). `post_process` runs after the response has gone
back to the customer, so a failure here cannot affect a live redemption:

```
api.request {
  url    = "https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/gp-shadow-compare"
  method = "POST"
  params = {}
    |set:"xano_ref":($request.id|to_text)
    |set:"image_url":("https://xmhi-aj9d-cnsb.n7.xano.io"|concat:$imagen_url.path:"")
    |set:"xano":({}
      |set:"product":$x2.product_name
      |set:"fee":$x2.value
      |set:"passengers":$groq.passengers
      |set:"voucher":$groq.voucher
      |set:"match_score":$x2.match_score
    )
  headers = []
    |push:"Content-Type: application/json"
    |push:("x-webhook-secret: @"|replace:"@":$env.supabase_webhook_secret)
  timeout = 20
}
```

`x-webhook-secret` is the same `XANO_WEBHOOK_SECRET` that `xano-booking-sync`
already uses, so no new secret is needed on the Supabase side. Set it as a Xano
env var.

This is a **write to a live Xano endpoint** and needs explicit sign-off before
anyone applies it. It is additive and inside `post_process`, but the rule is the
rule.

### Alternative: pull instead of push

If touching `vision_v4` is off the table, poll Xano's Metadata API for the
`vision_v4` request history instead and POST each new entry to the same function
with `source: "replay"`. Zero Xano changes, at the cost of a Xano personal access
token as a Supabase secret and a real limitation: Xano keeps only about the last
30 requests for that endpoint, so a poll that stalls loses vouchers permanently.
The push has no such hole.

## Reading the results

The disagreements are the point, not the percentage.

- `xano_only` → read the voucher, find the title we missed, add it as an alias.
- `different_product` → stop and investigate. Nothing else on this page is urgent.
- `ours_only` → usually Xano being wrong, but confirm it is not us matching a
  competitor. That is exactly what the N.Y.C voucher looked like.
- A rising `Model (AI)` count means new deal titles are in circulation that no
  alias covers.

**Aliases are the lever.** Almost every miss found so far was fixed by adding a
`tour_name_aliases` row, not by changing code.

**Write aliases short.** Groupon truncates the deal title to the phone's width,
so the same deal arrives as "...with a Free Bottled Water!", "...with a Free..."
and "...with a Fre...". An alias written as the full marketing title loses
coverage as the cut gets earlier and stops matching. Write the shortest form that
still identifies the deal.

## Seeded data

The table starts with 29 real vouchers replayed from Xano's request history on
2026-08-11: 22 agree, 0 wrong product, 6 we caught that Xano missed, 1 neither
matched (the N.Y.C voucher). 27 verbatim, 1 fuzzy, 0 AI.

A separate 100-voucher coverage run over `multimedia` (no Xano verdict attached,
so not in this table) matched 98, with the 2 misses both correct: the N.Y.C
voucher, and one whose screenshot clipped the title so badly that Google read
"Z People: YU-MIN SKyune Sunset Cruise" with the storefront scrolled off. Xano
rejects that one too.

## Cleanup

Shadow voucher images accumulate under `gp-vouchers/shadow/`. They are only
needed while a row is being reviewed. When the test ends, drop the bucket prefix
and the `gp_shadow_runs` table; nothing else depends on either.
