// Throwaway diagnostic. No imports, no database, no Sentry: just a delay and a reply.
// Delay comes from ?ms= so one deploy can find the threshold at which the platform
// stops delivering responses.
Deno.serve(async (req) => {
  const ms = Math.min(10_000, Number(new URL(req.url).searchParams.get("ms") ?? 0) || 0);
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  return new Response(JSON.stringify({ ok: true, ms }), {
    headers: { "content-type": "application/json" },
  });
});
