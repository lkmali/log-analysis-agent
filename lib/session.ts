import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { MembershipRow, OrgRole, OrganizationRow, PoolClient, QueryResultRow } from "@/backend/db";
import { getSessionUser, type SessionUser } from "./auth";
import { asUser } from "./db";

export const ACTIVE_ORG_COOKIE = "sre_active_org";

export interface DashboardSession {
  user: SessionUser;
  memberships: MembershipRow[];
  org: OrganizationRow;
  role: OrgRole;
  /** Run one query as this user (RLS-scoped). */
  query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run several queries in one RLS-scoped transaction. */
  tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

/** Loads the signed-in user and active organization for dashboard pages. */
export async function requireDashboardSession(): Promise<DashboardSession> {
  const user = await requireUser();

  const memberships = await asUser(user.id, async (c) => {
    const { rows } = await c.query<MembershipRow>(
      `select o.id, o.name, o.slug, m.role
         from public.organization_members m
         join public.organizations o on o.id = m.organization_id
        where m.user_id = $1
        order by m.created_at`,
      [user.id],
    );
    return rows;
  });
  if (memberships.length === 0) redirect("/onboarding");

  const preferred = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  const active = memberships.find((m) => m.id === preferred) ?? memberships[0]!;

  return {
    user,
    memberships,
    org: { id: active.id, name: active.name, slug: active.slug },
    role: active.role,
    query: async <T extends QueryResultRow>(sql: string, params: unknown[] = []) =>
      asUser(user.id, async (c) => (await c.query<T>(sql, params)).rows),
    tx: (fn) => asUser(user.id, fn),
  };
}

export function canManage(role: OrgRole) {
  return role === "owner" || role === "admin";
}

export function canOperate(role: OrgRole) {
  return role !== "viewer";
}
