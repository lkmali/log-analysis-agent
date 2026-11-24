import type { Settings } from "@/backend/settings/definitions";

/** AI settings are part of the platform settings (Settings → AI agents). */
export type AiConfig = Settings;

/** True when the agents have been provisioned and automatic investigation is switched on. */
export function aiReady(cfg: AiConfig) {
  return cfg.AI_ENABLED && !!cfg.AI_ENVIRONMENT_ID && !!cfg.AI_LOG_INVESTIGATOR_AGENT_ID && !!cfg.AI_PR_AUTHOR_AGENT_ID;
}
