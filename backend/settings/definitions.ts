import { z } from "zod";

/**
 * Every platform setting, in one place. Values live in the database
 * (public.platform_settings / private.platform_secrets), are edited by a superadmin
 * on the Settings page, and are re-read by the scheduler and AI agents on every run.
 *
 * This file is imported by both server and client code: keep it free of server imports.
 */

export type SettingGroup = "scheduler" | "alerts" | "aws" | "ai";

interface Base {
  key: string;
  group: SettingGroup;
  label: string;
  help?: string;
}
export type SettingDef = Base &
  (
    | { type: "int"; default: number; min: number; max: number }
    | { type: "number"; default: number; min: number; max: number; step: number }
    | { type: "enum"; default: string; options: readonly string[] }
    | { type: "string"; default: string; placeholder?: string }
    | { type: "boolean"; default: boolean }
    | { type: "secret"; placeholder?: string }
  );

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const SETTING_GROUPS: Record<SettingGroup, { title: string; description: string }> = {
  scheduler: { title: "Scheduler", description: "How often and how much the background jobs poll CloudWatch, and data retention." },
  alerts: { title: "Alerts", description: "When alerts are raised and where they are sent." },
  aws: { title: "AWS", description: "Credentials used for CloudWatch Logs (and as the base for assuming cross-account roles). Order: access key → profile → EC2 instance role." },
  ai: { title: "AI agents", description: "Claude agents that investigate incidents and open draft pull requests." },
};

export const SETTINGS = [
  // ---- Scheduler ----
  { key: "CW_TICK_SECONDS", group: "scheduler", label: "Poll tick (seconds)", help: "How often to look for log sources that are due.", type: "int", default: 15, min: 5, max: 300 },
  { key: "CW_SOURCES_PER_TICK", group: "scheduler", label: "Log sources per tick", type: "int", default: 50, min: 1, max: 1000 },
  { key: "CW_CONCURRENCY", group: "scheduler", label: "Parallel log sources", type: "int", default: 4, min: 1, max: 20 },
  { key: "CW_INITIAL_LOOKBACK_MINUTES", group: "scheduler", label: "Initial lookback (minutes)", help: "How far back the first poll of a new log group reads.", type: "int", default: 15, min: 1, max: 1440 },
  { key: "CW_OVERLAP_SECONDS", group: "scheduler", label: "Overlap window (seconds)", help: "Re-read window for late-arriving events (deduplicated).", type: "int", default: 120, min: 0, max: 3600 },
  { key: "CW_LAG_SECONDS", group: "scheduler", label: "Ingestion lag (seconds)", help: "Don't read the most recent N seconds.", type: "int", default: 15, min: 0, max: 300 },
  { key: "CW_MAX_EVENTS_PER_SOURCE_RUN", group: "scheduler", label: "Max events per source run", type: "int", default: 5000, min: 100, max: 100000 },
  { key: "CW_SOURCE_TIME_BUDGET_SECONDS", group: "scheduler", label: "Time budget per source (seconds)", type: "int", default: 45, min: 5, max: 600 },
  { key: "CW_MAX_SAMPLES_PER_INCIDENT", group: "scheduler", label: "Samples stored per incident", type: "int", default: 5, min: 0, max: 100 },
  { key: "PROCESSED_EVENT_RETENTION_HOURS", group: "scheduler", label: "Dedup retention (hours)", type: "int", default: 48, min: 1, max: 720 },
  { key: "SCHEDULER_RUN_RETENTION_DAYS", group: "scheduler", label: "Job history retention (days)", type: "int", default: 30, min: 1, max: 365 },
  { key: "LOG_LEVEL", group: "scheduler", label: "Log level", type: "enum", default: "info", options: ["debug", "info", "warn", "error"] },

  // ---- Alerts ----
  { key: "APP_BASE_URL", group: "alerts", label: "Dashboard URL", help: "Used for links in Slack and email alerts.", type: "string", default: "http://localhost:3000", placeholder: "https://sre.example.com" },
  { key: "NEW_INCIDENT_ALERT_MIN_SEVERITY", group: "alerts", label: "New-incident alert minimum severity", type: "enum", default: "high", options: SEVERITIES },
  { key: "SPIKE_THRESHOLD", group: "alerts", label: "Spike threshold", help: "Events of one error in a single poll that count as a spike.", type: "int", default: 50, min: 2, max: 1_000_000 },
  { key: "ALERT_NOTIFY_MIN_SEVERITY", group: "alerts", label: "Notify minimum severity", help: "Lower-severity alerts only show in the dashboard.", type: "enum", default: "medium", options: SEVERITIES },
  { key: "ALERT_DISPATCH_SECONDS", group: "alerts", label: "Dispatch interval (seconds)", type: "int", default: 30, min: 5, max: 3600 },
  { key: "PII_TYPES", group: "alerts", label: "PII types to detect", help: "Comma-separated, e.g. email,phone,aadhaar. Empty uses the built-in set.", type: "string", default: "" },
  { key: "SLACK_WEBHOOK_URL", group: "alerts", label: "Slack webhook URL", type: "secret", placeholder: "https://hooks.slack.com/services/…" },
  { key: "SMTP_URL", group: "alerts", label: "SMTP URL", type: "secret", placeholder: "smtps://user:pass@smtp.example.com:465" },
  { key: "ALERT_EMAIL_FROM", group: "alerts", label: "Alert email from", type: "string", default: "", placeholder: "sre@example.com" },
  { key: "ALERT_EMAIL_TO", group: "alerts", label: "Alert email to", help: "Comma-separated.", type: "string", default: "" },

  // ---- AWS ----
  { key: "AWS_REGION", group: "aws", label: "Default region", type: "string", default: "ap-south-1" },
  { key: "AWS_PROFILE", group: "aws", label: "Credentials profile", help: "Named profile from ~/.aws on the server. Empty uses the default chain (EC2 instance role).", type: "string", default: "" },
  { key: "AWS_ACCESS_KEY_ID", group: "aws", label: "Access key ID", help: "For local testing. Used together with the secret access key; takes precedence over the profile. Clear both in production so the EC2 instance role is used.", type: "secret", placeholder: "AKIA…" },
  { key: "AWS_SECRET_ACCESS_KEY", group: "aws", label: "Secret access key", help: "Pairs with the access key ID above.", type: "secret", placeholder: "wJalr…" },

  // ---- AI agents ----
  { key: "AI_ENABLED", group: "ai", label: "Investigate incidents automatically", type: "boolean", default: true },
  { key: "ANTHROPIC_API_KEY", group: "ai", label: "Anthropic API key", type: "secret", placeholder: "sk-ant-…" },
  { key: "GITHUB_TOKEN", group: "ai", label: "GitHub token", help: "Fine-grained, Contents + Pull requests read/write (plus Metadata read to list repositories). Used for the Repositories page, the sandbox git push, and the GitHub MCP server. Without it no PRs are opened.", type: "secret", placeholder: "github_pat_…" },
  { key: "GITHUB_MCP_URL", group: "ai", label: "GitHub MCP server URL", help: "The PR author reads the repository and opens pull requests through this MCP server. The GitHub token is stored in an Anthropic vault, never in the sandbox.", type: "string", default: "https://api.githubcopilot.com/mcp/" },
  { key: "AI_MODEL", group: "ai", label: "Model", type: "string", default: "claude-opus-5-5" },
  { key: "AI_INVESTIGATE_MIN_SEVERITY", group: "ai", label: "Minimum incident severity", type: "enum", default: "high", options: SEVERITIES },
  { key: "AI_MIN_FIX_CONFIDENCE", group: "ai", label: "Minimum confidence to attempt a fix", type: "number", default: 0.6, min: 0, max: 1, step: 0.05 },
  { key: "AI_TICK_SECONDS", group: "ai", label: "Check for new incidents every (seconds)", type: "int", default: 60, min: 15, max: 3600 },
  { key: "AI_INCIDENTS_PER_TICK", group: "ai", label: "Incidents per check", type: "int", default: 1, min: 1, max: 10 },
  { key: "AI_INVESTIGATOR_BUDGET_CENTS", group: "ai", label: "Investigator budget (US cents)", help: "Hard spend cap per session. 500 = $5.", type: "int", default: 500, min: 10, max: 100_000 },
  { key: "AI_PR_AUTHOR_BUDGET_CENTS", group: "ai", label: "PR author budget (US cents)", type: "int", default: 2000, min: 10, max: 100_000 },
  { key: "AI_SESSION_TIMEOUT_MINUTES", group: "ai", label: "Session timeout (minutes)", type: "int", default: 45, min: 1, max: 240 },
  { key: "AI_CONSOLE_WORKSPACE", group: "ai", label: "Claude Console workspace", help: "Only used to link to session traces.", type: "string", default: "default" },
  { key: "AI_ENVIRONMENT_ID", group: "ai", label: "Sandbox environment id", help: "Filled in by “Provision agents”.", type: "string", default: "" },
  { key: "AI_LOG_INVESTIGATOR_AGENT_ID", group: "ai", label: "Log investigator agent id", help: "Filled in by “Provision agents”.", type: "string", default: "" },
  { key: "AI_PR_AUTHOR_AGENT_ID", group: "ai", label: "PR author agent id", help: "Filled in by “Provision agents”.", type: "string", default: "" },
  { key: "AI_VAULT_ID", group: "ai", label: "Credential vault id", help: "Filled in by “Provision agents”. Holds the GitHub token for the MCP server.", type: "string", default: "" },
  { key: "AI_GITHUB_CREDENTIAL_ID", group: "ai", label: "GitHub MCP credential id", help: "Filled in by “Provision agents”.", type: "string", default: "" },
] as const satisfies readonly SettingDef[];

type Defs = (typeof SETTINGS)[number];
type ValueOf<D> = D extends { type: "int" | "number" } ? number
  : D extends { type: "boolean" } ? boolean
  : D extends { type: "enum"; options: readonly (infer O)[] } ? O
  : D extends { type: "secret" } ? string | undefined
  : string;

/** Fully-resolved settings (defaults applied). Secrets are undefined when not set. */
export type Settings = { [D in Defs as D["key"]]: ValueOf<D> };
export type SettingKey = Defs["key"];

export const SECRET_KEYS = SETTINGS.filter((d) => d.type === "secret").map((d) => d.key);
export const isSecretKey = (k: string) => (SECRET_KEYS as readonly string[]).includes(k);

/** zod validator for one setting's value (as submitted from the form or stored as JSON). */
export function valueSchema(def: SettingDef): z.ZodTypeAny {
  switch (def.type) {
    case "int": return z.coerce.number().int().min(def.min).max(def.max);
    case "number": return z.coerce.number().min(def.min).max(def.max);
    case "enum": return z.enum(def.options as [string, ...string[]]);
    case "boolean": return z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
    case "string": return z.string().trim().max(2000);
    case "secret": return z.string().trim().min(1).max(4000);
  }
}

/** Merges stored values over defaults. Invalid stored values fall back to the default. */
export function resolveSettings(stored: Record<string, unknown>, secrets: Record<string, string>): Settings {
  const out: Record<string, unknown> = {};
  for (const def of SETTINGS as readonly SettingDef[]) {
    if (def.type === "secret") {
      out[def.key] = secrets[def.key] || undefined;
      continue;
    }
    const parsed = def.key in stored ? valueSchema(def).safeParse(stored[def.key]) : undefined;
    out[def.key] = parsed?.success ? parsed.data : def.default;
  }
  return out as Settings;
}
