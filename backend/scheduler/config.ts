import type { Severity } from "@/backend/db";
import type { Settings } from "@/backend/settings/definitions";

/**
 * Scheduler configuration = the platform settings (edited on the Settings page),
 * reloaded before every job run. Nothing here comes from environment variables.
 */
export type Config = Settings & { piiTypes?: string[] };

export function toSchedulerConfig(settings: Settings): Config {
  const piiTypes = settings.PII_TYPES.split(",").map((s) => s.trim()).filter(Boolean);
  return { ...settings, piiTypes: piiTypes.length ? piiTypes : undefined };
}

export const severityRank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
