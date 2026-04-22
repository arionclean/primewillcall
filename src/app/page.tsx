import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
      <section className="mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center gap-8 px-6 text-center">
        <p className="rounded-full border px-4 py-1 font-mono text-xs text-muted-foreground">
          Next.js 15 • TypeScript • Tailwind • shadcn/ui • Supabase
        </p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          Welcome to PrimeWillCall
        </h1>
        <p className="max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
          Your new project is ready in this repository and prepared for Vercel
          deployment. Start building from this page.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            className={buttonVariants({ size: "lg" })}
            href="https://vercel.com/new"
            rel="noreferrer"
            target="_blank"
          >
            Deploy on Vercel
          </Link>
          <Link
            className={buttonVariants({ size: "lg", variant: "secondary" })}
            href="https://ui.shadcn.com/docs"
            rel="noreferrer"
            target="_blank"
          >
            Open shadcn Docs
          </Link>
          <Link
            className={buttonVariants({ size: "lg", variant: "outline" })}
            href="https://supabase.com/docs"
            rel="noreferrer"
            target="_blank"
          >
            Open Supabase Docs
          </Link>
        </div>

        <div className="w-full rounded-xl border bg-card p-6 text-left">
          <h2 className="mb-2 text-lg font-medium">Next Steps</h2>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>1. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.</li>
            <li>2. Import `getSupabaseBrowserClient()` where client-side data is needed.</li>
            <li>3. Link this repo to Vercel and deploy.</li>
          </ul>
        </div>
      </section>
    </main>
  );
}
