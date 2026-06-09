/**
 * Shown instantly while a page in the app group server-renders. The shell
 * (sidebar/topbar) lives in the layout and stays put, so this only fills the
 * content area, which makes navigation feel immediate instead of frozen.
 */
export default function Loading() {
  return (
    <div className="animate-pulse space-y-6" aria-hidden>
      <div className="space-y-2">
        <div className="h-7 w-44 rounded-md bg-muted" />
        <div className="h-4 w-72 rounded bg-muted/60" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl border bg-muted/40" />
        ))}
      </div>
      <div className="h-72 rounded-xl border bg-muted/30" />
    </div>
  );
}
