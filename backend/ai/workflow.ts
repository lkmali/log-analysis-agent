import type { createPool } from "@/backend/db";
import type { WorkflowState } from "@/backend/db";
import type { Logger } from "@/backend/scheduler/logger";
import type { AiConfig } from "./config";
import { awsBaseCredentials } from "@/backend/scheduler/aws";
import { GITHUB_MCP_SERVER } from "./agents";
import { syncGithubCredential } from "./provision";
import { estimateCostUsd, runAgentSession, type McpPolicy, type SessionResult } from "./session";
import { logInvestigatorTools, type IncidentScope, type InvestigationFindings } from "./tools/log-tools";
import { prAuthorTools, type PrAuthorResult, type RepoTarget } from "./tools/pr-tools";

type Pool = ReturnType<typeof createPool>;

/**
 * Incident -> log investigator agent -> (if a code fix is plausible) PR author agent.
 * Application code owns every state transition and side effect; the agents only
 * reason and act through the tools we hand them.
 */
export async function runIncidentWorkflow(pool: Pool, log: Logger, cfg: AiConfig, scope: IncidentScope) {
  const wlog = log.child({ incidentId: scope.incidentId, investigationId: scope.investigationId });

  // ---- 1. Investigate the logs ------------------------------------------------
  let findings: InvestigationFindings | undefined;
  const investigation = await runTracked(pool, scope, "log-investigator", cfg.AI_MODEL, () =>
    runAgentSession({
      log: wlog,
      timeoutMinutes: cfg.AI_SESSION_TIMEOUT_MINUTES,
      consoleWorkspace: cfg.AI_CONSOLE_WORKSPACE,
      apiKey: cfg.ANTHROPIC_API_KEY,
      tools: logInvestigatorTools(pool, scope, awsBaseCredentials(cfg), async (f) => {
        findings = f;
        await pool.query(
          `update public.investigations
              set summary = $2, root_cause = nullif($3, ''), confidence = $4, analysis = $5
            where id = $1`,
          [scope.investigationId, f.summary, f.root_cause, f.confidence, JSON.stringify(f)],
        );
      }),
      create: {
        agent: cfg.AI_LOG_INVESTIGATOR_AGENT_ID!,
        environment_id: cfg.AI_ENVIRONMENT_ID!,
        title: `Investigate incident ${scope.incidentId}`,
        metadata: { incident_id: scope.incidentId, investigation_id: scope.investigationId },
        budget: { type: "limit", max_list_cost: { amount: String(cfg.AI_INVESTIGATOR_BUDGET_CENTS), currency: "USD" } },
        initial_events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Investigate the incident assigned to this session and submit your findings." }],
          },
        ],
      },
    }),
  );

  if (!findings) {
    await finish(pool, scope, investigation.outcome === "end_turn" ? "NEEDS_HUMAN_REVIEW" : "FAILED");
    wlog.warn("investigation produced no findings", { outcome: investigation.outcome, error: investigation.error });
    return;
  }

  // ---- 2. Decide whether to attempt a fix -------------------------------------
  const repo = findings.repository_id ? await loadRepo(pool, scope, findings.repository_id) : undefined;
  const skip =
    !findings.fixable_in_code ? "not a code defect" :
    !repo ? "no repository identified" :
    findings.confidence < cfg.AI_MIN_FIX_CONFIDENCE ? `confidence ${findings.confidence} < ${cfg.AI_MIN_FIX_CONFIDENCE}` :
    !cfg.GITHUB_TOKEN ? "GITHUB_TOKEN not set" :
    !cfg.AI_VAULT_ID ? "no credential vault (run Provision agents)" :
    undefined;
  if (skip || !repo) {
    wlog.info("not attempting a fix", { reason: skip });
    await finish(pool, scope, "NEEDS_HUMAN_REVIEW");
    return;
  }

  // ---- 3. Fix the code and open a draft PR (through the GitHub MCP server) ------
  // Push the current token into the vault so a token changed on the Settings page applies now.
  const credentialId = await syncGithubCredential(cfg, { forceCreate: false });
  if (credentialId !== cfg.AI_GITHUB_CREDENTIAL_ID) {
    await pool.query(
      `insert into public.platform_settings (key, value, updated_at) values ('AI_GITHUB_CREDENTIAL_ID', $1, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(credentialId)],
    );
  }
  await setState(pool, scope, "PATCH_PROPOSED");
  const branchPrefix = `ai/incident-${scope.incidentId.slice(0, 8)}`;
  let prResult: PrAuthorResult | undefined;
  const testCommands = repo.testCommands.length ? repo.testCommands.map((c) => `- \`${c}\``).join("\n") : "- (none configured: do not run commands that modify anything outside the repository)";

  const author = await runTracked(pool, scope, "pr-author", cfg.AI_MODEL, () =>
    runAgentSession({
      log: wlog,
      timeoutMinutes: cfg.AI_SESSION_TIMEOUT_MINUTES,
      consoleWorkspace: cfg.AI_CONSOLE_WORKSPACE,
      apiKey: cfg.ANTHROPIC_API_KEY,
      tools: prAuthorTools(pool, scope, repo, branchPrefix, cfg.GITHUB_TOKEN!, (r) => { prResult = r; }),
      mcpPolicy: githubMcpPolicy(repo, branchPrefix),
      create: {
        agent: cfg.AI_PR_AUTHOR_AGENT_ID!,
        environment_id: cfg.AI_ENVIRONMENT_ID!,
        title: `Fix incident ${scope.incidentId} in ${repo.owner}/${repo.name}`,
        metadata: { incident_id: scope.incidentId, investigation_id: scope.investigationId },
        budget: { type: "limit", max_list_cost: { amount: String(cfg.AI_PR_AUTHOR_BUDGET_CENTS), currency: "USD" } },
        vault_ids: [cfg.AI_VAULT_ID!],
        resources: [
          {
            type: "github_repository",
            url: `https://github.com/${repo.owner}/${repo.name}`,
            mount_path: "/workspace/repo",
            authorization_token: cfg.GITHUB_TOKEN!,
            checkout: { type: "branch", name: repo.defaultBranch },
          },
        ],
        initial_events: [
          {
            type: "user.message",
            content: [{
              type: "text",
              text: [
                `The repository ${repo.owner}/${repo.name} is checked out at /workspace/repo on its base branch "${repo.defaultBranch}".`,
                `Create your branch with the prefix "${branchPrefix}" (for example "${branchPrefix}-fix").`,
                `Open the pull request with the GitHub MCP tool create_pull_request: owner "${repo.owner}", repo "${repo.name}", base "${repo.defaultBranch}", draft true. End the body with: "Opened by the loger-agents AI PR author for incident ${scope.incidentId}. Draft: review before marking it ready; it is never merged automatically." Then call record_pull_request.`,
                `Test commands you may run:\n${testCommands}`,
                "Start by calling get_investigation.",
              ].join("\n\n"),
            }],
          },
          {
            type: "user.define_outcome",
            description: "Fix the defect described by get_investigation and open a draft pull request, or report why no safe fix exists.",
            // Starter rubric - tune the criteria to your repositories.
            rubric: {
              type: "text",
              content: [
                "# PR rubric",
                `- Either a draft PR was opened with create_pull_request from a pushed branch starting with "${branchPrefix}" and recorded with record_pull_request, or report_no_fix was called with a concrete, evidence-based reason`,
                "- The change addresses the root cause from get_investigation, not only the symptom",
                "- The diff is limited to what the fix needs: no unrelated refactors, formatting churn, or dependency changes",
                "- A regression test covers the failure when the repository has a test suite",
                "- The listed test commands were run on the final code; any failure is explained in the PR body",
                "- The PR body states root cause, log evidence, what changed, tests run with results, and risks",
                `- Nothing was pushed to "${repo.defaultBranch}", and no secrets or log data containing personal information were committed`,
              ].join("\n"),
            },
            max_iterations: 3,
          },
        ],
      },
    }),
  );

  const finalPr: PrAuthorResult | undefined = prResult;
  if (finalPr?.kind === "pr") {
    wlog.info("draft pull request opened", { url: finalPr.url });
    await finish(pool, scope, "AWAITING_APPROVAL");
  } else {
    wlog.info("no pull request", { reason: finalPr?.reason ?? author.outcome, error: author.error });
    await finish(pool, scope, "NEEDS_HUMAN_REVIEW");
  }
}

/** GitHub MCP read tools: get_*, list_*, search_*, and the consolidated *_read tools. */
const GITHUB_READ_TOOL = /^(get_|list_|search_)|_read$/;

/**
 * Fixed approval policy for the PR author's GitHub MCP calls (every call pauses as always_ask):
 * read tools on the target repository are allowed; create_pull_request is allowed (max 3 tries) only as
 * a draft from a branch with the incident prefix into the base branch of the target repository;
 * every other GitHub write is denied.
 */
export function githubMcpPolicy(repo: RepoTarget, branchPrefix: string): McpPolicy {
  let prAttempts = 0; // a failed attempt (e.g. branch not pushed yet) may be retried
  const sameRepo = (input: Record<string, unknown>) =>
    (input.owner === undefined || String(input.owner).toLowerCase() === repo.owner.toLowerCase()) &&
    (input.repo === undefined || String(input.repo).toLowerCase() === repo.name.toLowerCase());

  return ({ server, name, input }) => {
    if (server !== GITHUB_MCP_SERVER) return { allow: false, reason: `Unknown MCP server "${server}".` };
    if (!sameRepo(input)) return { allow: false, reason: `Only ${repo.owner}/${repo.name} may be used.` };

    if (name === "create_pull_request") {
      const head = String(input.head ?? "").replace(/^[^:]+:/, ""); // accept "owner:branch"
      if (prAttempts >= 3) return { allow: false, reason: "Too many create_pull_request attempts. Call record_pull_request or report_no_fix." };
      if (input.owner === undefined || input.repo === undefined) return { allow: false, reason: "Set owner and repo." };
      if (input.draft !== true) return { allow: false, reason: "Set draft to true." };
      if (!head.startsWith(branchPrefix)) return { allow: false, reason: `head must start with "${branchPrefix}".` };
      if (input.base !== repo.defaultBranch) return { allow: false, reason: `base must be "${repo.defaultBranch}".` };
      prAttempts++;
      return { allow: true };
    }
    if (GITHUB_READ_TOOL.test(name)) return { allow: true };
    return { allow: false, reason: `GitHub tool "${name}" is not allowed. Use git in the sandbox for code changes, and create_pull_request to open the PR.` };
  };
}

async function loadRepo(pool: Pool, scope: IncidentScope, repositoryId: string): Promise<RepoTarget | undefined> {
  const { rows } = await pool.query<{ id: string; owner: string; name: string; default_branch: string; test_commands: string[] }>(
    `select id, owner, name, default_branch, test_commands from public.repositories
      where id = $1 and organization_id = $2 and enabled and provider = 'github'`,
    [repositoryId, scope.organizationId],
  );
  const r = rows[0];
  return r && { id: r.id, owner: r.owner, name: r.name, defaultBranch: r.default_branch, testCommands: r.test_commands };
}

async function setState(pool: Pool, scope: IncidentScope, state: WorkflowState) {
  await pool.query("update public.investigations set status = $2 where id = $1", [scope.investigationId, state]);
  await pool.query("update public.incidents set workflow_state = $2 where id = $1", [scope.incidentId, state]);
}

/** Terminal state for this run; the incident always ends up in front of a human. */
async function finish(pool: Pool, scope: IncidentScope, state: WorkflowState) {
  await setState(pool, scope, state);
  await pool.query(
    "update public.incidents set status = 'needs_review' where id = $1 and status = 'investigating'",
    [scope.incidentId],
  );
}

/** Records the session in agent_runs + model_usage_events (shown on the dashboard). */
async function runTracked(
  pool: Pool,
  scope: IncidentScope,
  agentName: string,
  model: string,
  run: () => Promise<SessionResult>,
): Promise<SessionResult> {
  const started = Date.now();
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.agent_runs (organization_id, investigation_id, agent_name, model, status, started_at)
     values ($1, $2, $3, $4, 'running', now()) returning id`,
    [scope.organizationId, scope.investigationId, agentName, model],
  );
  const runId = rows[0]!.id;
  let result: SessionResult;
  try {
    result = await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      "update public.agent_runs set status = 'failed', error = $2, finished_at = now(), latency_ms = $3 where id = $1",
      [runId, message.slice(0, 2000), Date.now() - started],
    );
    throw err;
  }
  const ok = result.outcome === "end_turn";
  const u = result.usage;
  await pool.query(
    `update public.agent_runs
        set status = $2, error = $3, input_tokens = $4, output_tokens = $5, latency_ms = $6, finished_at = now()
      where id = $1`,
    [runId, ok ? "succeeded" : "failed", ok ? null : `${result.outcome}${result.error ? `: ${result.error}` : ""} (session ${result.sessionId})`,
     u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens, u.outputTokens, Date.now() - started],
  );
  await pool.query(
    `insert into public.model_usage_events
       (organization_id, incident_id, agent_run_id, model, input_tokens, output_tokens, cached_input_tokens,
        latency_ms, succeeded, estimated_cost_usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [scope.organizationId, scope.incidentId, runId, model, u.inputTokens + u.cacheWriteTokens, u.outputTokens,
     u.cacheReadTokens, Date.now() - started, ok, estimateCostUsd(u).toFixed(6)],
  );
  return result;
}
