"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createOrganizationSchema } from "@/backend/validation";
import { getSessionUser } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { ACTIVE_ORG_COOKIE } from "@/lib/session";

export interface OnboardingState {
  error?: string;
}

export async function createOrganization(_prev: OnboardingState, formData: FormData): Promise<OnboardingState> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const parsed = createOrganizationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  let orgId: string;
  try {
    // Role-checked, audited function: creates the org and makes the caller owner.
    orgId = await asUser(user.id, async (c) => {
      const { rows } = await c.query<{ id: string }>("select app.create_organization($1, $2) as id", [
        parsed.data.name,
        parsed.data.slug,
      ]);
      return rows[0]!.id;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { error: "That slug is already taken" };
    throw err;
  }

  (await cookies()).set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  redirect("/overview");
}
