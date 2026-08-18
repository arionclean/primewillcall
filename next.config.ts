import type { NextConfig } from "next";

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

export default nextConfig;
