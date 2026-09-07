"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Last-resort error screen. Next renders this when the root layout itself
 * throws, which is why it has to draw its own <html> and <body>. The error is
 * reported to Sentry; the staffer gets a plain sentence and a retry, never the
 * raw message (nothing internal is shown to staff, see CLAUDE.md).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The page could not be shown. The team has been notified. You can try
            again, or go back to the dashboard.
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              Try again
            </button>
            <a
              href="/dashboard"
              className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium"
            >
              Dashboard
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
