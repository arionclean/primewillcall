import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  // Client-side Router Cache. Without this, Next treats every dynamic route as
  // uncacheable, so re-clicking a screen you just left re-renders it on the
  // server from scratch. 30s means back/forward and quick round-trips between
  // screens paint from memory instead of hitting the network. Anything that
  // writes still calls revalidatePath / router.refresh, which busts the entry,
  // and the live screens (bookings, messages) re-sync over Realtime on mount.
  experimental: {
    staleTimes: { dynamic: 30, static: 180 },
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.xano.io",
      },
      {
        protocol: "https",
        hostname: "**.supabase.co",
      },
    ],
  },
};

// Sentry: uploads source maps at build time when SENTRY_ORG / SENTRY_PROJECT /
// SENTRY_AUTH_TOKEN are set (Vercel, production), so stack traces read as the
// TypeScript source. Without them the build still succeeds and the SDK still
// reports errors, just against minified frames. See docs/sentry.md.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
});
