import { resolveSettings } from "@/backend/settings/definitions";
import { requireDashboardSession } from "@/lib/session";
import { ProvisionAgents, SettingsForm, SuperadminForm } from "./settings-form";

export const metadata = { title: "Settings · Claude SRE" };

export default async function SettingsPage() {
  const { user, tx } = await requireDashboardSession();

  const { stored, secretStatus } = await tx(async (c) => {
    const stored = (await c.query<{ key: string; value: unknown }>("select key, value from public.platform_settings")).rows;
    const secretStatus = (await c.query<{ key: string; updated_at: Date }>("select key, updated_at from app.platform_secret_status()")).rows;
    return { stored, secretStatus };
  });

  const overridden = stored.map((r) => r.key);
  // Secret values never reach the dashboard; "set" is only a marker for resolveSettings.
  const values = resolveSettings(
    Object.fromEntries(stored.map((r) => [r.key, r.value])),
    Object.fromEntries(secretStatus.map((s) => [s.key, "set"])),
  );
  const secretsSet = secretStatus.map((s) => s.key);
  const editable = user.isSuperadmin;
  const agentsProvisioned = !!values.AI_ENVIRONMENT_ID && !!values.AI_LOG_INVESTIGATOR_AGENT_ID && !!values.AI_PR_AUTHOR_AGENT_ID;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            Platform-wide configuration for the scheduler, alerts, AWS and AI agents.{" "}
            {editable ? "You are a superadmin and can change these." : "Only a superadmin can change these; you have view access."}
          </p>
        </div>
      </div>

      <SettingsForm values={values} overridden={overridden} secretsSet={secretsSet} editable={editable} />

      {editable && (
        <div className="stack" style={{ marginTop: 24, maxWidth: 760 }}>
          <ProvisionAgents provisioned={agentsProvisioned} keySet={secretsSet.includes("ANTHROPIC_API_KEY")} />
          <SuperadminForm />
        </div>
      )}
    </>
  );
}
