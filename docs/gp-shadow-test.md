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

Paste the block below into `vision_v4` (API 1930, group `vision`), inside the
`util.post_process { stack { ... } }` it already has, **immediately after**
`} as $multimedia1`. Nothing else in the endpoint changes.

`post_process` runs after the response has already gone back to the customer, and
the `try_catch` swallows failures, so neither a Supabase outage nor a wrong
secret can affect a live redemption. The worst case is that no shadow row is
recorded.

```
// Shadow test: mirror this voucher and Xano's verdict to the Supabase matcher
// so the two can be compared. Read-only for Xano.
try_catch {
  try {
    api.request {
      url = "https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/gp-shadow-compare"
      method = "POST"
      params = {}
        |set:"xano_ref":$multimedia1.id
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
        |push:"x-webhook-secret: " ~ $env.XANO_BOOKING_SYNC_SECRET
      timeout = 20
    } as $shadow1
  }
}
```

Everything it references already exists in that endpoint's stack: `$multimedia1`
(the row written on the line above), `$imagen_url` (the stored voucher),
`$x2` (the match lambda's result) and `$groq` (the extraction).

**No new secret.** It reuses `$env.XANO_BOOKING_SYNC_SECRET`, the same value the
`sync booking to supabase_v1` function already sends to `xano-booking-sync`, and
the same value Supabase checks as `XANO_WEBHOOK_SECRET`. The `~` concatenation is
copied from that function so the idiom matches.

`xano_ref` is the `multimedia` row id, which makes the push idempotent and lines
up with a replay over the same table.

This is a **write to a live Xano endpoint**. It has to be pasted by a human: the
agent's Xano write tools are blocked by Claude Code's permission classifier, and
a full-script rewrite of a live endpoint through a tool call is riskier than a
15-line paste anyway.

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

### Passenger mismatches are expected, and we are the correct side

`passengers_match = false` is not a defect to chase. A voucher reading

    1 Person: 90-Minute The Homes of the Rich & Famous Boat Tour
    3 of 3

is one person, on a voucher the customer holds three of. We return 1. Xano
returns 3, multiplying the person count by the voucher count, which is the exact
trap both prompts warn about and which Xano's own model then falls into.

Confirmed with the owner on 2026-08-14: **we bill the voucher that was actually
uploaded**, so passengers come from the title alone and "N of N" is ignored. A
customer redeeming three vouchers uploads three vouchers. Do not "fix" this to
agree with Xano.

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
