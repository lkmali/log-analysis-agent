import type { createPool } from "@/backend/db";
import type { Settings } from "@/backend/settings/definitions";
import { loadSettings, saveSettingValues } from "@/backend/settings/store";
import { ENVIRONMENT, logInvestigatorAgent, prAuthorAgent } from "./agents";
import { anthropic } from "./client";

type Pool = ReturnType<typeof createPool>;

/**
 * Creates (first time) or updates in place (afterwards) the Managed Agents environment,
 * the two agents, and the credential vault holding the GitHub token for the GitHub MCP
 * server, and stores their ids in the platform settings. Triggered by a superadmin from
 * Settings → AI agents → "Provision agents". Never called per incident.
 */
export async function provisionAgents(ownerPool: Pool): Promise<string[]> {
  const cfg = await loadSettings(ownerPool, { fresh: true });
  const client = anthropic(cfg.ANTHROPIC_API_KEY);
  const report: string[] = [];
  const ids: Record<string, string> = {};

  if (cfg.AI_ENVIRONMENT_ID) {
    await client.beta.environments.update(cfg.AI_ENVIRONMENT_ID, { config: ENVIRONMENT.config });
    report.push(`Updated sandbox environment ${cfg.AI_ENVIRONMENT_ID}`);
  } else {
    const env = await client.beta.environments.create(ENVIRONMENT);
    ids.AI_ENVIRONMENT_ID = env.id;
    report.push(`Created sandbox environment ${env.id}`);
  }

  const agents = [
    { key: "AI_LOG_INVESTIGATOR_AGENT_ID", id: cfg.AI_LOG_INVESTIGATOR_AGENT_ID, params: logInvestigatorAgent(cfg.AI_MODEL) },
    { key: "AI_PR_AUTHOR_AGENT_ID", id: cfg.AI_PR_AUTHOR_AGENT_ID, params: prAuthorAgent(cfg.AI_MODEL, cfg.GITHUB_MCP_URL) },
  ] as const;
  for (const a of agents) {
    if (a.id) {
      const updated = await client.beta.agents.update(a.id, a.params);
      report.push(`Updated ${a.params.name} to version ${updated.version}`);
    } else {
      const created = await client.beta.agents.create(a.params);
      ids[a.key] = created.id;
      report.push(`Created ${a.params.name} (${created.id})`);
    }
  }

  // ---- Vault: GitHub token for the GitHub MCP server --------------------------
  let vaultId = cfg.AI_VAULT_ID;
  if (!vaultId) {
    const vault = await client.beta.vaults.create({ display_name: "loger-agents", metadata: { app: "loger-agents" } });
    vaultId = ids.AI_VAULT_ID = vault.id;
    report.push(`Created credential vault ${vault.id}`);
  }
  if (cfg.GITHUB_TOKEN) {
    const credentialId = await syncGithubCredential({ ...cfg, AI_VAULT_ID: vaultId }, { forceCreate: false });
    if (credentialId !== cfg.AI_GITHUB_CREDENTIAL_ID) ids.AI_GITHUB_CREDENTIAL_ID = credentialId;
    report.push(`GitHub MCP credential ${credentialId} is up to date (${cfg.GITHUB_MCP_URL})`);
  } else {
    report.push("GitHub token not set: the PR author cannot reach the GitHub MCP server until you save one and provision again");
  }

  if (Object.keys(ids).length) await saveSettingValues(ownerPool, ids);
  return report;
}

/**
 * Writes the current GitHub token into the vault's static_bearer credential for the MCP URL
 * (creating it if needed) and returns the credential id. Called by provisioning and before
 * every PR author session, so a token changed on the Settings page applies on the next run.
 * The credential's MCP URL is immutable: if the URL setting changed, a new credential is created.
 */
export async function syncGithubCredential(
  cfg: Pick<Settings, "ANTHROPIC_API_KEY" | "AI_VAULT_ID" | "AI_GITHUB_CREDENTIAL_ID" | "GITHUB_TOKEN" | "GITHUB_MCP_URL">,
  { forceCreate }: { forceCreate: boolean },
): Promise<string> {
  if (!cfg.AI_VAULT_ID) throw new Error("No credential vault: run Settings → AI agents → Provision agents");
  if (!cfg.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not set");
  const client = anthropic(cfg.ANTHROPIC_API_KEY);
  const vault_id = cfg.AI_VAULT_ID;

  if (cfg.AI_GITHUB_CREDENTIAL_ID && !forceCreate) {
    const existing = await client.beta.vaults.credentials
      .retrieve(cfg.AI_GITHUB_CREDENTIAL_ID, { vault_id })
      .catch(() => undefined);
    const sameUrl = existing && "mcp_server_url" in existing.auth &&
      normalizeUrl(String(existing.auth.mcp_server_url)) === normalizeUrl(cfg.GITHUB_MCP_URL);
    if (existing && sameUrl && !existing.archived_at) {
      await client.beta.vaults.credentials.update(existing.id, {
        vault_id,
        auth: { type: "static_bearer", token: cfg.GITHUB_TOKEN },
      });
      return existing.id;
    }
    if (existing && !existing.archived_at) {
      await client.beta.vaults.credentials.archive(existing.id, { vault_id }).catch(() => {});
    }
  }

  const created = await client.beta.vaults.credentials.create(vault_id, {
    display_name: "GitHub MCP (loger-agents)",
    auth: { type: "static_bearer", mcp_server_url: cfg.GITHUB_MCP_URL, token: cfg.GITHUB_TOKEN },
  });
  return created.id;
}

const normalizeUrl = (u: string) => u.trim().toLowerCase().replace(/\/+$/, "");
