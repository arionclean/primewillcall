import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type TeamRole = "admin" | "kiosk";

type CreateTeamMemberBody = {
  companyId?: string;
  fullName?: string;
  email?: string;
  password?: string;
  role?: TeamRole;
  isActive?: boolean;
  permissions?: {
    can_edit_booking?: boolean;
    can_delete_booking?: boolean;
    can_delete_transaction?: boolean;
    can_refund?: boolean;
    can_create_booking?: boolean;
  };
  productIds?: string[];
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonError(
      "Team account creation requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.",
      500,
    );
  }

  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";

  if (!token) {
    return jsonError("Missing signed-in user token.", 401);
  }

  let body: CreateTeamMemberBody;
  try {
    body = (await request.json()) as CreateTeamMemberBody;
  } catch {
    return jsonError("Invalid request body.");
  }

  const companyId = body.companyId?.trim();
  const fullName = body.fullName?.trim();
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  const role: TeamRole = body.role === "admin" ? "admin" : "kiosk";
  const productIds = Array.isArray(body.productIds) ? body.productIds : [];

  if (!companyId) {
    return jsonError("Company is required.");
  }
  if (!fullName) {
    return jsonError("Full name is required.");
  }
  if (!email) {
    return jsonError("Email is required.");
  }
  if (password.length < 6) {
    return jsonError("Temporary password must be at least 6 characters.");
  }

  const serviceSupabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const {
    data: { user },
    error: userError,
  } = await serviceSupabase.auth.getUser(token);

  if (userError || !user) {
    return jsonError("Invalid signed-in user token.", 401);
  }

  const { data: company, error: companyError } = await serviceSupabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .eq("user_id", user.id)
    .single();

  if (companyError || !company) {
    return jsonError("You do not have access to this company.", 403);
  }

  const { data: authUser, error: authError } = await serviceSupabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      role: role === "admin" ? "merchant" : "kiosk",
      team_role: role,
      company_id: companyId,
      full_name: fullName,
    },
  });

  if (authError || !authUser.user) {
    return jsonError(authError?.message ?? "Unable to create auth account.", 400);
  }

  const permissions = body.permissions ?? {};
  const { data: teamMember, error: teamError } = await serviceSupabase
    .from("team_members")
    .insert({
      company_id: companyId,
      auth_user_id: authUser.user.id,
      created_by: user.id,
      full_name: fullName,
      email,
      role,
      is_active: body.isActive ?? true,
      can_edit_booking: Boolean(permissions.can_edit_booking),
      can_delete_booking: Boolean(permissions.can_delete_booking),
      can_delete_transaction: Boolean(permissions.can_delete_transaction),
      can_refund: Boolean(permissions.can_refund),
      can_create_booking: Boolean(permissions.can_create_booking),
    })
    .select("*")
    .single();

  if (teamError || !teamMember) {
    await serviceSupabase.auth.admin.deleteUser(authUser.user.id);
    return jsonError(teamError?.message ?? "Unable to save team member.", 400);
  }

  if (productIds.length > 0) {
    const { data: ownedProducts, error: productError } = await serviceSupabase
      .from("products")
      .select("id")
      .eq("company_id", companyId)
      .in("id", productIds);

    if (productError) {
      return jsonError(productError.message, 400);
    }

    const safeProductIds = new Set((ownedProducts ?? []).map((product) => product.id as string));
    const rows = productIds
      .filter((productId) => safeProductIds.has(productId))
      .map((productId) => ({
        team_member_id: teamMember.id,
        product_id: productId,
      }));

    if (rows.length > 0) {
      const { error: accessError } = await serviceSupabase.from("team_member_products").insert(rows);

      if (accessError) {
        return jsonError(accessError.message, 400);
      }
    }
  }

  return NextResponse.json({ teamMember });
}
