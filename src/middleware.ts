import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Session refresh + route gating.
 *
 * - Refreshes the Supabase auth cookie on every matched request so server components
 *   downstream see a fresh session. The refresh happens inside the Supabase
 *   client (it reads the cookies and writes back any rotated ones), not in the
 *   identity check below.
 * - If the user is NOT signed in and they hit a protected route, redirect to /login.
 * - If the user IS signed in and they hit /login, send them to /dashboard.
 *
 * The matcher below targets only the routes that need gating; static assets,
 * the home page, and most public files are excluded.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // No Supabase configured (e.g. during early local dev). Let the request through.
    return response;
  }

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // `getClaims()` verifies the access token locally against the project's
  // public signing key (ES256), so the gate below costs no network round-trip.
  // `getUser()` called the Auth server on every matched request, including
  // every client-side navigation, which was the single biggest fixed cost in
  // the app. auth-js falls back to the network call by itself if the token
  // cannot be verified locally, so this is not a weaker check.
  const { data: claimsData } = await supabase.auth.getClaims();
  const user = claimsData?.claims?.sub ? claimsData.claims : null;

  const pathname = request.nextUrl.pathname;
  const isLoginRoute = pathname === "/login" || pathname.startsWith("/login/");

  if (!user && !isLoginRoute) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (user && isLoginRoute) {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = "/dashboard";
    dashboardUrl.search = "";
    return NextResponse.redirect(dashboardUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/bookings/:path*",
    "/customers/:path*",
    "/schedule/:path*",
    "/analytics/:path*",
    "/admin/:path*",
    "/login",
    "/login/:path*",
  ],
};
