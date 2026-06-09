"use client";

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarPlus,
  Check,
  Eye,
  KeyRound,
  LayoutDashboard,
  Monitor,
  Package,
  Pencil,
  Receipt,
  Settings,
  ShieldCheck,
  UserPlus,
  UserRoundCheck,
  UserRoundX,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import GlobalSearchBar from "@/components/global-search-bar";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type TeamRole = "admin" | "kiosk";

type Company = {
  id: string;
  name: string | null;
  email: string | null;
};

type Product = {
  id: string;
  product_name: string;
  short_name: string;
  color: string | null;
};

type TeamMember = {
  id: string;
  company_id: string;
  auth_user_id: string | null;
  full_name: string;
  email: string;
  role: TeamRole;
  is_active: boolean;
  can_edit_booking: boolean;
  can_delete_booking: boolean;
  can_delete_transaction: boolean;
  can_refund: boolean;
  can_create_booking: boolean;
  created_at: string;
};

type TeamMemberProduct = {
  team_member_id: string;
  product_id: string;
};

type PermissionKey =
  | "can_edit_booking"
  | "can_delete_booking"
  | "can_delete_transaction"
  | "can_refund"
  | "can_create_booking";

type TeamForm = {
  fullName: string;
  email: string;
  password: string;
  role: TeamRole;
  isActive: boolean;
  permissions: Record<PermissionKey, boolean>;
  productIds: string[];
};

const sidebarItems = [
  { label: "Overview", icon: LayoutDashboard, href: "/dashboard" },
  { label: "Orders", icon: Receipt, href: "/orders" },
  { label: "Schedule", icon: CalendarPlus, href: "/schedule" },
  { label: "Products", icon: Package, href: "/products" },
  { label: "Kiosks", icon: Monitor, href: "/kiosks" },
  { label: "Team", icon: Users, href: "/team", active: true },
  { label: "Settings", icon: Settings, href: "#" },
];

const permissions: Array<{ key: PermissionKey; label: string }> = [
  { key: "can_edit_booking", label: "Edit booking" },
  { key: "can_delete_booking", label: "Delete booking" },
  { key: "can_delete_transaction", label: "Delete transaction" },
  { key: "can_refund", label: "Refund" },
  { key: "can_create_booking", label: "Create booking" },
];

const emptyPermissions: Record<PermissionKey, boolean> = {
  can_edit_booking: false,
  can_delete_booking: false,
  can_delete_transaction: false,
  can_refund: false,
  can_create_booking: false,
};

const adminPermissions: Record<PermissionKey, boolean> = {
  can_edit_booking: true,
  can_delete_booking: true,
  can_delete_transaction: true,
  can_refund: true,
  can_create_booking: true,
};

function buildEmptyForm(): TeamForm {
  return {
    fullName: "",
    email: "",
    password: "",
    role: "kiosk",
    isActive: true,
    permissions: { ...emptyPermissions },
    productIds: [],
  };
}

function buildEditForm(member: TeamMember, productIds: string[]): TeamForm {
  return {
    fullName: member.full_name,
    email: member.email,
    password: "",
    role: member.role,
    isActive: member.is_active,
    permissions: {
      can_edit_booking: member.can_edit_booking,
      can_delete_booking: member.can_delete_booking,
      can_delete_transaction: member.can_delete_transaction,
      can_refund: member.can_refund,
      can_create_booking: member.can_create_booking,
    },
    productIds,
  };
}

function TeamContent() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isTeamLoading, setIsTeamLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [memberProducts, setMemberProducts] = useState<TeamMemberProduct[]>([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [form, setForm] = useState<TeamForm>(() => buildEmptyForm());

  const accessByMemberId = useMemo(() => {
    const map = new Map<string, string[]>();

    for (const row of memberProducts) {
      const productIds = map.get(row.team_member_id) ?? [];
      productIds.push(row.product_id);
      map.set(row.team_member_id, productIds);
    }

    return map;
  }, [memberProducts]);

  useEffect(() => {
    const load = async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data: sessionData } = await supabase.auth.getSession();

        if (!sessionData.session) {
          router.replace("/login");
          return;
        }

        const { data: companyRows, error: companyError } = await supabase
          .from("companies")
          .select("id, name, email")
          .eq("user_id", sessionData.session.user.id)
          .order("created_at", { ascending: true });

        if (companyError) {
          throw new Error(companyError.message);
        }

        const safeCompanies = (companyRows ?? []) as Company[];
        setCompanies(safeCompanies);
        setSelectedCompanyId(safeCompanies[0]?.id ?? "");
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Unable to load team.");
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [router]);

  useEffect(() => {
    if (!selectedCompanyId) {
      setProducts([]);
      setTeamMembers([]);
      setMemberProducts([]);
      return;
    }

    let cancelled = false;

    const loadTeamData = async () => {
      setIsTeamLoading(true);
      setLoadError(null);

      try {
        const supabase = getSupabaseBrowserClient();
        const [{ data: productRows, error: productError }, { data: memberRows, error: memberError }] =
          await Promise.all([
            supabase
              .from("products")
              .select("id, product_name, short_name, color")
              .eq("company_id", selectedCompanyId)
              .order("created_at", { ascending: true }),
            supabase
              .from("team_members")
              .select(
                "id, company_id, auth_user_id, full_name, email, role, is_active, can_edit_booking, can_delete_booking, can_delete_transaction, can_refund, can_create_booking, created_at",
              )
              .eq("company_id", selectedCompanyId)
              .order("created_at", { ascending: false }),
          ]);

        if (productError) {
          throw new Error(productError.message);
        }
        if (memberError) {
          throw new Error(memberError.message);
        }

        const safeMembers = (memberRows ?? []) as TeamMember[];
        let accessRows: TeamMemberProduct[] = [];

        if (safeMembers.length > 0) {
          const { data: productAccessRows, error: accessError } = await supabase
            .from("team_member_products")
            .select("team_member_id, product_id")
            .in(
              "team_member_id",
              safeMembers.map((member) => member.id),
            );

          if (accessError) {
            throw new Error(accessError.message);
          }

          accessRows = (productAccessRows ?? []) as TeamMemberProduct[];
        }

        if (!cancelled) {
          setProducts((productRows ?? []) as Product[]);
          setTeamMembers(safeMembers);
          setMemberProducts(accessRows);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Unable to load team.");
        }
      } finally {
        if (!cancelled) {
          setIsTeamLoading(false);
        }
      }
    };

    void loadTeamData();

    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId]);

  const openCreateDialog = () => {
    setEditingMember(null);
    setForm(buildEmptyForm());
    setFormError(null);
    setSuccessMessage(null);
    setIsDialogOpen(true);
  };

  const openEditDialog = (member: TeamMember) => {
    setEditingMember(member);
    setForm(buildEditForm(member, accessByMemberId.get(member.id) ?? []));
    setFormError(null);
    setSuccessMessage(null);
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    if (isSubmitting) {
      return;
    }

    setIsDialogOpen(false);
    setFormError(null);
  };

  const updatePermission = (key: PermissionKey, value: boolean) => {
    setForm((current) => ({
      ...current,
      permissions: {
        ...current.permissions,
        [key]: value,
      },
    }));
  };

  const updateRole = (role: TeamRole) => {
    setForm((current) => ({
      ...current,
      role,
      permissions: role === "admin" && !editingMember ? { ...adminPermissions } : current.permissions,
      productIds: role === "admin" && !editingMember ? products.map((product) => product.id) : current.productIds,
    }));
  };

  const toggleProductAccess = (productId: string) => {
    setForm((current) => ({
      ...current,
      productIds: current.productIds.includes(productId)
        ? current.productIds.filter((currentProductId) => currentProductId !== productId)
        : [...current.productIds, productId],
    }));
  };

  const selectAllProducts = () => {
    setForm((current) => ({
      ...current,
      productIds: products.map((product) => product.id),
    }));
  };

  const clearProducts = () => {
    setForm((current) => ({
      ...current,
      productIds: [],
    }));
  };

  const handleSignOut = async () => {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  const reloadTeam = async () => {
    if (!selectedCompanyId) {
      return;
    }

    const supabase = getSupabaseBrowserClient();
    const { data: memberRows, error: memberError } = await supabase
      .from("team_members")
      .select(
        "id, company_id, auth_user_id, full_name, email, role, is_active, can_edit_booking, can_delete_booking, can_delete_transaction, can_refund, can_create_booking, created_at",
      )
      .eq("company_id", selectedCompanyId)
      .order("created_at", { ascending: false });

    if (memberError) {
      throw new Error(memberError.message);
    }

    const safeMembers = (memberRows ?? []) as TeamMember[];
    let accessRows: TeamMemberProduct[] = [];

    if (safeMembers.length > 0) {
      const { data: productAccessRows, error: accessError } = await supabase
        .from("team_member_products")
        .select("team_member_id, product_id")
        .in(
          "team_member_id",
          safeMembers.map((member) => member.id),
        );

      if (accessError) {
        throw new Error(accessError.message);
      }

      accessRows = (productAccessRows ?? []) as TeamMemberProduct[];
    }

    setTeamMembers(safeMembers);
    setMemberProducts(accessRows);
  };

  const saveProductAccess = async (memberId: string, productIds: string[]) => {
    const supabase = getSupabaseBrowserClient();
    const { error: deleteError } = await supabase
      .from("team_member_products")
      .delete()
      .eq("team_member_id", memberId);

    if (deleteError) {
      throw new Error(deleteError.message);
    }

    if (productIds.length === 0) {
      return;
    }

    const { error: insertError } = await supabase.from("team_member_products").insert(
      productIds.map((productId) => ({
        team_member_id: memberId,
        product_id: productId,
      })),
    );

    if (insertError) {
      throw new Error(insertError.message);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setSuccessMessage(null);

    if (!selectedCompanyId) {
      setFormError("Pick a company before creating a team member.");
      return;
    }
    if (!form.fullName.trim()) {
      setFormError("Full name is required.");
      return;
    }
    if (!form.email.trim()) {
      setFormError("Email is required.");
      return;
    }
    if (!editingMember && form.password.length < 6) {
      setFormError("Temporary password must be at least 6 characters.");
      return;
    }

    setIsSubmitting(true);

    try {
      const supabase = getSupabaseBrowserClient();

      if (editingMember) {
        const { error: updateError } = await supabase
          .from("team_members")
          .update({
            full_name: form.fullName.trim(),
            role: form.role,
            is_active: form.isActive,
            can_edit_booking: form.permissions.can_edit_booking,
            can_delete_booking: form.permissions.can_delete_booking,
            can_delete_transaction: form.permissions.can_delete_transaction,
            can_refund: form.permissions.can_refund,
            can_create_booking: form.permissions.can_create_booking,
          })
          .eq("id", editingMember.id);

        if (updateError) {
          throw new Error(updateError.message);
        }

        await saveProductAccess(editingMember.id, form.productIds);
        setSuccessMessage("Team member updated.");
      } else {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;

        if (!accessToken) {
          throw new Error("You need to sign in again before creating a team account.");
        }

        const response = await fetch("/api/team-members", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            companyId: selectedCompanyId,
            fullName: form.fullName,
            email: form.email,
            password: form.password,
            role: form.role,
            isActive: form.isActive,
            permissions: form.permissions,
            productIds: form.productIds,
          }),
        });

        const result = (await response.json()) as { error?: string };

        if (!response.ok) {
          throw new Error(result.error ?? "Unable to create team account.");
        }

        setSuccessMessage("Team account created.");
      }

      await reloadTeam();
      setIsDialogOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to save team member.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
        <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
          <p className="text-sm text-muted-foreground">Loading team...</p>
        </section>
      </main>
    );
  }

  const inputClass =
    "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50";
  const labelClass = "grid gap-1.5 text-sm font-medium";
  const formCanSubmit =
    Boolean(selectedCompanyId) &&
    form.fullName.trim().length > 0 &&
    form.email.trim().length > 0 &&
    (editingMember ? true : form.password.length >= 6);

  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
      <section className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
          <aside className="hidden rounded-xl border bg-card p-4 lg:sticky lg:top-6 lg:block lg:h-[calc(100vh-4rem)]">
            <div className="mb-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Prime</p>
              <h2 className="mt-1 text-lg font-semibold">Dashboard</h2>
            </div>
            <nav className="space-y-1">
              {sidebarItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                      item.active
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="mt-6 rounded-lg border bg-background p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Search</p>
              <div className="mt-2">
                <GlobalSearchBar companyId={selectedCompanyId} />
              </div>
            </div>
            <div className="mt-6 rounded-lg border bg-background p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Company</p>
              <select
                value={selectedCompanyId}
                onChange={(event) => setSelectedCompanyId(event.target.value)}
                className="mt-2 h-9 w-full rounded-md border bg-background px-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {companies.length === 0 ? (
                  <option value="">No companies found</option>
                ) : (
                  companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name ?? company.email ?? "Unnamed company"}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="mt-6">
              <Button variant="outline" onClick={handleSignOut} className="w-full">
                Sign out
              </Button>
            </div>
          </aside>

          <div>
            <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:hidden">
              <select
                value={selectedCompanyId}
                onChange={(event) => setSelectedCompanyId(event.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {companies.length === 0 ? (
                  <option value="">No companies found</option>
                ) : (
                  companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name ?? company.email ?? "Unnamed company"}
                    </option>
                  ))
                )}
              </select>
              <Button variant="outline" onClick={handleSignOut} className="h-9">
                Sign out
              </Button>
            </div>
            <div className="mb-3 lg:hidden">
              <GlobalSearchBar companyId={selectedCompanyId} />
            </div>

            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Team</p>
                <h1 className="text-3xl font-semibold tracking-tight">Team accounts</h1>
              </div>
              <Button onClick={openCreateDialog} disabled={!selectedCompanyId}>
                <UserPlus className="size-4" />
                Add team member
              </Button>
            </div>

            {loadError ? (
              <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {loadError}
              </p>
            ) : null}
            {successMessage ? (
              <p className="mb-4 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                <Check className="size-4" />
                {successMessage}
              </p>
            ) : null}

            <section className="rounded-xl border bg-card">
              <div className="border-b px-4 py-3">
                <h2 className="font-semibold tracking-tight">Team members</h2>
              </div>
              <div className="p-3">
                {isTeamLoading ? (
                  <p className="px-2 py-6 text-sm text-muted-foreground">Loading team...</p>
                ) : teamMembers.length === 0 ? (
                  <div className="px-2 py-10 text-center">
                    <Users className="mx-auto size-8 text-muted-foreground" />
                    <p className="mt-3 text-sm font-medium">No team accounts yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Add admins or kiosk users and control the products they can view.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border">
                    {teamMembers.map((member) => {
                      const productIds = accessByMemberId.get(member.id) ?? [];
                      const enabledPermissionCount = permissions.filter(
                        (permission) => member[permission.key],
                      ).length;

                      return (
                        <article
                          key={member.id}
                          className="grid min-h-16 grid-cols-[minmax(12rem,1.4fr)_8rem_8rem_minmax(10rem,1fr)_auto] items-center gap-3 border-b bg-background px-3 py-2 text-sm last:border-b-0"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{member.full_name}</p>
                            <p className="truncate text-muted-foreground">{member.email}</p>
                          </div>
                          <span
                            className={cn(
                              "inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
                              member.role === "admin"
                                ? "bg-sky-50 text-sky-700"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {member.role === "admin" ? (
                              <ShieldCheck className="size-3.5" />
                            ) : (
                              <KeyRound className="size-3.5" />
                            )}
                            {member.role === "admin" ? "Admin" : "Kiosk"}
                          </span>
                          <span
                            className={cn(
                              "inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
                              member.is_active
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {member.is_active ? (
                              <UserRoundCheck className="size-3.5" />
                            ) : (
                              <UserRoundX className="size-3.5" />
                            )}
                            {member.is_active ? "Active" : "Disabled"}
                          </span>
                          <div className="min-w-0 text-muted-foreground">
                            <p className="truncate">{enabledPermissionCount} permissions enabled</p>
                            <p className="truncate">{productIds.length} products visible</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => openEditDialog(member)}
                            aria-label={`Edit ${member.full_name}`}
                            className="inline-flex size-9 items-center justify-center rounded-md text-indigo-500 transition hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            <Pencil className="size-4" />
                          </button>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {isDialogOpen ? (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 animate-in fade-in duration-200"
                role="presentation"
                onMouseDown={closeDialog}
              >
                <form
                  onSubmit={handleSubmit}
                  className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-300"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="team-dialog-title"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div className="flex items-center justify-between border-b px-4 py-2.5">
                    <h2 id="team-dialog-title" className="font-semibold tracking-tight">
                      {editingMember ? "Edit team member" : "New team member"}
                    </h2>
                    <button
                      type="button"
                      onClick={closeDialog}
                      aria-label="Close team member modal"
                      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <X className="size-4" />
                    </button>
                  </div>

                  <div className="grid gap-4 overflow-y-auto p-3 lg:grid-cols-[1fr_1.1fr]">
                    <section className="grid gap-3">
                      <h3 className="border-b pb-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        Account
                      </h3>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className={labelClass}>
                          Full name
                          <input
                            required
                            value={form.fullName}
                            onChange={(event) =>
                              setForm((current) => ({ ...current, fullName: event.target.value }))
                            }
                            className={inputClass}
                          />
                        </label>
                        <label className={labelClass}>
                          Email
                          <input
                            required
                            type="email"
                            value={form.email}
                            disabled={Boolean(editingMember)}
                            onChange={(event) =>
                              setForm((current) => ({ ...current, email: event.target.value }))
                            }
                            className={cn(inputClass, editingMember ? "bg-muted/50 text-muted-foreground" : "")}
                          />
                        </label>
                      </div>
                      {!editingMember ? (
                        <label className={labelClass}>
                          Temporary password
                          <input
                            required
                            type="password"
                            minLength={6}
                            value={form.password}
                            onChange={(event) =>
                              setForm((current) => ({ ...current, password: event.target.value }))
                            }
                            className={inputClass}
                          />
                        </label>
                      ) : null}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className={labelClass}>
                          Role
                          <select
                            value={form.role}
                            onChange={(event) => updateRole(event.target.value as TeamRole)}
                            className={inputClass}
                          >
                            <option value="admin">Admin</option>
                            <option value="kiosk">Kiosk</option>
                          </select>
                        </label>
                        <label className="flex items-end gap-2 text-sm font-medium">
                          <input
                            type="checkbox"
                            checked={form.isActive}
                            onChange={(event) =>
                              setForm((current) => ({ ...current, isActive: event.target.checked }))
                            }
                            className="mb-2 size-4 accent-primary"
                          />
                          <span className="pb-1.5">Account active</span>
                        </label>
                      </div>

                      <h3 className="border-b pb-1.5 pt-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        Permissions
                      </h3>
                      <div className="grid gap-2">
                        {permissions.map((permission) => (
                          <label
                            key={permission.key}
                            className="flex min-h-10 items-center justify-between gap-3 rounded-md border bg-background px-3 text-sm"
                          >
                            <span>{permission.label}</span>
                            <input
                              type="checkbox"
                              checked={form.permissions[permission.key]}
                              onChange={(event) => updatePermission(permission.key, event.target.checked)}
                              className="size-4 accent-primary"
                            />
                          </label>
                        ))}
                      </div>
                    </section>

                    <section className="grid content-start gap-3">
                      <div className="flex items-center justify-between gap-3 border-b pb-1.5">
                        <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                          Product access
                        </h3>
                        <Eye className="size-4 text-muted-foreground" />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" onClick={selectAllProducts} className="h-8">
                          Select all
                        </Button>
                        <Button type="button" variant="ghost" onClick={clearProducts} className="h-8">
                          Clear
                        </Button>
                      </div>
                      <div className="max-h-[24rem] overflow-y-auto rounded-lg border bg-background p-2">
                        {products.length === 0 ? (
                          <p className="px-2 py-6 text-sm text-muted-foreground">No products found.</p>
                        ) : (
                          products.map((product) => {
                            const isSelected = form.productIds.includes(product.id);

                            return (
                              <label
                                key={product.id}
                                className="flex min-h-10 items-center gap-3 rounded-md px-2 text-sm transition hover:bg-muted"
                              >
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleProductAccess(product.id)}
                                  className="size-4 accent-primary"
                                />
                                <span
                                  className="size-3 shrink-0 rounded-full border"
                                  style={{ backgroundColor: product.color || "#dff7e7" }}
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate">
                                  {product.short_name || product.product_name}
                                </span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    </section>
                  </div>

                  {formError ? (
                    <p className="mx-4 mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {formError}
                    </p>
                  ) : null}

                  <div className="flex items-center justify-end gap-3 border-t bg-muted/40 px-4 py-2.5">
                    <Button type="button" variant="ghost" onClick={closeDialog} disabled={isSubmitting}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={isSubmitting || !formCanSubmit} className="h-9">
                      {isSubmitting ? "Saving..." : editingMember ? "Save changes" : "Create account"}
                    </Button>
                  </div>
                </form>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

export default function TeamPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
          <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
            <p className="text-sm text-muted-foreground">Loading team...</p>
          </section>
        </main>
      }
    >
      <TeamContent />
    </Suspense>
  );
}
