"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ACTIVE_ORG_COOKIE } from "@/lib/session";

/** Only stores a preference; requireDashboardSession() ignores ids the user isn't a member of. */
export async function switchOrganization(orgId: string) {
  if (!z.string().uuid().safeParse(orgId).success) return;
  (await cookies()).set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  revalidatePath("/", "layout");
}
