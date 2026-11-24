"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { credentialsSchema } from "@/backend/validation";
import { hashPassword } from "@/lib/auth";
import { requireDashboardSession } from "@/lib/session";

export interface CreateUserState {
  ok?: string;
  error?: string;
}

const createUserSchema = credentialsSchema.extend({
  displayName: z.string().trim().max(100).optional(),
  organizationId: z.union([z.literal(""), z.string().uuid()]),
  role: z.enum(["owner", "admin", "member", "viewer"]),
  superadmin: z.boolean(),
});

export async function createUserAction(_prev: CreateUserState, formData: FormData): Promise<CreateUserState> {
  const session = await requireDashboardSession();
  // Re-check in the database, not just the cached session; app.create_user() checks again.
  const [row] = await session.query<{ ok: boolean }>("select app.is_superadmin() as ok");
  if (!row?.ok) return { error: "Only a superadmin can add users." };

  const parsed = createUserSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("displayName") ?? undefined,
    organizationId: formData.get("organizationId") ?? "",
    role: formData.get("role"),
    superadmin: formData.get("superadmin") === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;

  // Only allow adding to organizations the superadmin belongs to (what the form offers).
  if (d.organizationId && !session.memberships.some((m) => m.id === d.organizationId)) {
    return { error: "Unknown organization" };
  }

  try {
    await session.query("select app.create_user($1, $2, $3, $4, $5, $6)", [
      d.email,
      await hashPassword(d.password),
      d.displayName || null,
      d.superadmin,
      d.organizationId || null,
      d.role,
    ]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { error: "An account with this email already exists" };
    return { error: (err as { message?: string }).message ?? "Could not create user" };
  }

  revalidatePath("/users");
  return { ok: `Created ${d.email}. Share the password with them securely.` };
}
