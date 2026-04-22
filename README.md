# PrimeWillCall Web

Starter project with:
- Next.js 15 (App Router)
- TypeScript
- Tailwind CSS v4
- shadcn/ui
- Supabase JavaScript client
- Ready to deploy on Vercel

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables:

```bash
cp .env.example .env.local
```

Set:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

3. Start dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Supabase Client

Use the browser client helper:

```ts
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

const supabase = getSupabaseBrowserClient();
```

## UI Consistency

Team UI standards live in [`docs/shadcn-foundation.md`](/Users/main/Primewillcall(new platform)/docs/shadcn-foundation.md).  
Follow this guide for all new screens/components to keep a unified design system.

## Deploy on Vercel

1. Push this repository to GitHub.
2. Import the repo in [Vercel](https://vercel.com/new).
3. Add the same Supabase env vars in Vercel Project Settings.
