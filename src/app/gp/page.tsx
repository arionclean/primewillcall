import type { Metadata } from "next";

import { GrouponFlow } from "./gp-flow";

export const metadata: Metadata = {
  title: "Redeem your Groupon voucher",
  description: "Upload your Groupon voucher to reserve your tour.",
};

/**
 * Public, unauthenticated Groupon redemption page (/gp). It sits outside the
 * (app) route group, so the auth gate never runs on it, and it is absent from
 * the middleware matcher, so it is never redirected to /login. All data access
 * goes through the /api/gp/* route handlers (service role, server-side).
 */
export default function GrouponPage() {
  return <GrouponFlow />;
}
