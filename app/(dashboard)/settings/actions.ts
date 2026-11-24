"use server";

import { revalidatePath } from "next/cache";
import Anthropic from "@anthropic-ai/sdk";
import { provisionAgents } from "@/backend/ai/provision";
import { getOwnerPool } from "@/backend/db/pools";
import { SETTINGS, valueSchema, type SettingDef } from "@/backend/settings/definitions";
import { invalidateSettings } from "@/backend/settings/store";
import { requireDashboardSession } from "@/lib/session";

export interface ActionState {
  ok?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
}

/** Re-checks superadmin in the database (not just the cached session) before any write. */
async function requireSuperadmin() {
  const session = await requireDashboardSession();
  const [row] = await session.query<{ ok: boolean }>("select app.is_superadmin() as ok");
  if (!row?.ok) throw new Error("Only a superadmin can change settings.");
  return session;
}

export async function saveSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let session;
  try {
    session = await requireSuperadmin();
  } catch (e) {
    return { error: (e as Error).message };
  }

  const values: Record<string, unknown> = {};
  const secrets: Record<string, string | null> = {};
  const fieldErrors: Record<string, string> = {};

  for (const def of SETTINGS as readonly SettingDef[]) {
    if (def.type === "secret") {
      if (formData.get(`${def.key}__clear`) === "on") {
        secrets[def.key] = null;
        continue;
      }
      const v = String(formData.get(def.key) ?? "").trim();
      if (v) secrets[def.key] = v;
      continue;
    }
    const raw = def.type === "boolean" ? formData.get(def.key) === "on" : String(formData.get(def.key) ?? "");
    const parsed = valueSchema(def).safeParse(raw);
    if (!parsed.success) {
      fieldErrors[def.key] = parsed.error.issues[0]?.message ?? "Invalid value";
      continue;
    }
    // Storing only overrides keeps defaults upgradeable; a value equal to the default is removed.
    values[def.key] = parsed.data === def.default ? null : parsed.data;
  }

  if (values.ALERT_EMAIL_TO && !values.ALERT_EMAIL_FROM) fieldErrors.ALERT_EMAIL_FROM = "Required when “Alert email to” is set";
  if (Object.keys(fieldErrors).length) return { error: "Fix the highlighted fields.", fieldErrors };

  try {
    await session.query("select app.update_platform_settings($1::jsonb, $2::jsonb)", [
      JSON.stringify(values),
      JSON.stringify(secrets),
    ]);
  } catch (e) {
    return { error: (e as { message?: string }).message ?? "Could not save settings" };
  }
  invalidateSettings(); // the scheduler in this process picks the change up on its next run
  revalidatePath("/settings");
  return { ok: "Settings saved. They apply on the next scheduler run." };
}

export async function provisionAgentsAction(_prev: ActionState): Promise<ActionState> {
  try {
    await requireSuperadmin();
  } catch (e) {
    return { error: (e as Error).message };
  }
  try {
    const report = await provisionAgents(getOwnerPool());
    revalidatePath("/settings");
    return { ok: report.join(" · ") };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { error: "The Anthropic API key was rejected. Save a valid key first." };
    if (e instanceof Anthropic.APIError) return { error: `Anthropic API error ${e.status}: ${e.message}` };
    return { error: (e as Error).message ?? "Provisioning failed" };
  }
}

export async function setSuperadminAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let session;
  try {
    session = await requireSuperadmin();
  } catch (e) {
    return { error: (e as Error).message };
  }
  const email = String(formData.get("email") ?? "").trim();
  const grant = formData.get("grant") === "true";
  if (!email) return { error: "Enter an email." };
  try {
    await session.query("select app.set_superadmin($1, $2)", [email, grant]);
  } catch (e) {
    return { error: (e as { message?: string }).message ?? "Could not update superadmin" };
  }
  revalidatePath("/settings");
  return { ok: grant ? `${email} is now a superadmin.` : `${email} is no longer a superadmin.` };
}
