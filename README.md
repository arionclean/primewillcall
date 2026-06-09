# PrimeWillCall

Operations platform for Prime, a tour and scheduled-experience operator. Prime is a
single platform-level owner that runs multiple businesses (for example Miami Skyline
Cruises and Key West Sightseeing Tours). Staff create and manage per-passenger bookings
against scheduled tours.

This repo is the new platform, migrated from a live Bubble.io + Xano stack to
Supabase + Vercel. See [`docs/platform-migration.md`](docs/platform-migration.md) for
the migration guardrails (the old stack is still live in production).

## Stack

- Next.js 15 (App Router, Turbopack), React 19, TypeScript (strict)
- Tailwind CSS v4, shadcn-style UI primitives, lucide-react icons
- Supabase: Postgres + Row Level Security, Auth, Storage, Realtime
- Leaflet + CARTO tiles (meeting-point map), Google Places API (server-proxied)
- Deploys on Vercel

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:3000
```

Required env vars (see `.env.example` for the full list and notes):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — browser + server client
- `SUPABASE_SERVICE_ROLE_KEY` — server-only admin client (bypasses RLS, never ship to the browser)
- `GOOGLE_MAPS_API_KEY` — server-only, used by the Places proxy routes

The Supabase project is `qbnizuhozzwkiitfkjee`.

## How the app is organized

- Roles (`staff.role` enum): `owner` (Prime, platform-wide), `business_manager`
  (one business), `check_in` (desk staff).
- All app pages live under the `(app)` route group, which renders the shared shell
  (topbar, sidebar, global search) and enforces auth.
- Data access is scoped by Postgres RLS, not by client-side filtering. The signed-in
  user only ever reads or writes rows their role allows.

For the full picture, read:

- [`CLAUDE.md`](CLAUDE.md) — architecture, conventions, and how to debug. Start here.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — routes, data flow, and patterns.
- [`docs/DATABASE.md`](docs/DATABASE.md) — schema, relationships, and RLS model.
- [`docs/shadcn-foundation.md`](docs/shadcn-foundation.md) — UI consistency rules.

## Scripts

- `npm run dev` — dev server (Turbopack) on port 3000
- `npm run build` — production build
- `npm run start` — serve the production build
- `npm run lint` — ESLint

The project should always be green: `npx tsc --noEmit` (0 errors) and `npm run lint`
(0 warnings).

## Deploy on Vercel

1. Push to GitHub and import the repo in Vercel.
2. Add the same env vars in Vercel project settings (mark the service-role and Google
   keys as server-only / not exposed to the browser).
