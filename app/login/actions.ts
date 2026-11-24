"use server";

import { redirect } from "next/navigation";
import { describeDbError } from "@/backend/db";
import { credentialsSchema } from "@/backend/validation";
import { startSession, verifyCredentials } from "@/lib/auth";

export interface AuthState {
  error?: string;
}

function safeNext(next: FormDataEntryValue | null) {
  const n = typeof next === "string" ? next : "";
  return n.startsWith("/") && !n.startsWith("//") ? n : "/overview";
}

// There is no public sign-up: accounts are created by a superadmin on the Users page.
export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentialsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Invalid email or password" };

  try {
    const userId = await verifyCredentials(parsed.data.email, parsed.data.password);
    if (!userId) return { error: "Invalid email or password" };
    await startSession(userId);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "sign-in failed", error: (err as Error)?.message, code: (err as { code?: string })?.code }));
    const detail = describeDbError(err);
    if (detail && process.env.NODE_ENV !== "production") return { error: detail };
    return { error: "Sign-in is temporarily unavailable. Please try again later." };
  }

  // Outside the try: redirect() works by throwing, so it must not be caught above.
  redirect(safeNext(formData.get("next")));
}
