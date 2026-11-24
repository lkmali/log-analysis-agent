"use client";

import { useActionState, useState } from "react";
import { SETTING_GROUPS, SETTINGS, type SettingDef, type SettingGroup, type Settings } from "@/backend/settings/definitions";
import { provisionAgentsAction, saveSettings, setSuperadminAction, type ActionState } from "./actions";

const GROUP_ORDER: SettingGroup[] = ["ai", "alerts", "aws", "scheduler"];

export function SettingsForm({
  values,
  overridden,
  secretsSet,
  editable,
}: {
  values: Settings;
  overridden: string[];
  secretsSet: string[];
  editable: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveSettings, {});

  return (
    <form action={action} className="stack" style={{ maxWidth: 760 }}>
      {GROUP_ORDER.map((group) => (
        <section key={group} className="card stack">
          <div>
            <h2 style={{ marginBottom: 2 }}>{SETTING_GROUPS[group].title}</h2>
            <p className="muted" style={{ margin: 0 }}>{SETTING_GROUPS[group].description}</p>
          </div>
          {(SETTINGS as readonly SettingDef[])
            .filter((d) => d.group === group)
            .map((def) => (
              <Field
                key={def.key}
                def={def}
                value={(values as Record<string, unknown>)[def.key]}
                isOverridden={overridden.includes(def.key)}
                secretSet={secretsSet.includes(def.key)}
                editable={editable}
                error={state.fieldErrors?.[def.key]}
              />
            ))}
        </section>
      ))}

      {editable && (
        <div className="row" style={{ position: "sticky", bottom: 0, background: "var(--bg)", padding: "12px 0" }}>
          <button type="submit" className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save settings"}</button>
          {state.ok && <p className="notice">{state.ok}</p>}
          {state.error && <p className="error">{state.error}</p>}
        </div>
      )}
    </form>
  );
}

function Field({
  def,
  value,
  isOverridden,
  secretSet,
  editable,
  error,
}: {
  def: SettingDef;
  value: unknown;
  isOverridden: boolean;
  secretSet: boolean;
  editable: boolean;
  error?: string;
}) {
  const [clear, setClear] = useState(false);
  const label = (
    <span>
      {def.label}{" "}
      <code className="muted" style={{ fontWeight: 400 }}>{def.key}</code>
      {def.type !== "secret" && !isOverridden && <span className="muted" style={{ fontWeight: 400 }}> · default</span>}
    </span>
  );
  const help = (def.help || error) && (
    <small className={error ? "error" : undefined}>{error ?? def.help}</small>
  );

  if (def.type === "secret") {
    return (
      <div className="field">
        {label}
        <span className={secretSet ? "badge st-ok" : "badge st-neutral"} style={{ fontWeight: 400 }}>
          {secretSet ? "Configured" : "Not set"}
        </span>
        {editable && (
          <div className="row">
            <input
              name={def.key}
              type="password"
              autoComplete="off"
              disabled={clear}
              placeholder={secretSet ? "Leave empty to keep the current value" : def.placeholder}
              style={{ flex: 1, minWidth: 220 }}
            />
            {secretSet && (
              <label className="row" style={{ gap: 6, width: "auto" }}>
                <input type="checkbox" name={`${def.key}__clear`} checked={clear} onChange={(e) => setClear(e.target.checked)} style={{ width: "auto" }} />
                Clear
              </label>
            )}
          </div>
        )}
        {help}
      </div>
    );
  }

  if (def.type === "boolean") {
    return (
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" name={def.key} defaultChecked={value === true} disabled={!editable} style={{ width: "auto" }} />
        {label}
        {help}
      </label>
    );
  }

  return (
    <label className="field">
      {label}
      {def.type === "enum" ? (
        <select name={def.key} defaultValue={String(value)} disabled={!editable}>
          {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          name={def.key}
          type={def.type === "string" ? "text" : "number"}
          defaultValue={String(value ?? "")}
          disabled={!editable}
          readOnly={!editable}
          placeholder={def.type === "string" ? def.placeholder : undefined}
          {...(def.type === "int" || def.type === "number"
            ? { min: def.min, max: def.max, step: def.type === "int" ? 1 : def.step }
            : {})}
        />
      )}
      {help}
    </label>
  );
}

export function ProvisionAgents({ provisioned, keySet }: { provisioned: boolean; keySet: boolean }) {
  const [state, action, pending] = useActionState<ActionState>(provisionAgentsAction, {});
  return (
    <form action={action} className="card stack">
      <div>
        <h2 style={{ marginBottom: 2 }}>AI agents</h2>
        <p className="muted" style={{ margin: 0 }}>
          {provisioned
            ? "The agents are provisioned. Run this again after changing the model or the agent prompts to update them in place."
            : "Creates the sandbox environment and the two Claude agents in your Anthropic account and saves their ids above."}
          {!keySet && " Save an Anthropic API key first."}
        </p>
      </div>
      <div className="row">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Working…" : provisioned ? "Update agents" : "Provision agents"}
        </button>
        {state.ok && <p className="notice">{state.ok}</p>}
        {state.error && <p className="error">{state.error}</p>}
      </div>
    </form>
  );
}

export function SuperadminForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(setSuperadminAction, {});
  return (
    <form action={action} className="card stack">
      <div>
        <h2 style={{ marginBottom: 2 }}>Superadmins</h2>
        <p className="muted" style={{ margin: 0 }}>Superadmins can change these settings. Everyone else gets a read-only view.</p>
      </div>
      <div className="row">
        <input name="email" type="email" placeholder="user@example.com" required style={{ flex: 1, minWidth: 220 }} />
        <button type="submit" name="grant" value="true" className="btn" disabled={pending}>Make superadmin</button>
        <button type="submit" name="grant" value="false" className="btn" disabled={pending}>Remove</button>
      </div>
      {state.ok && <p className="notice">{state.ok}</p>}
      {state.error && <p className="error">{state.error}</p>}
    </form>
  );
}
