import { z } from "zod";
import { withTransaction, type createPool } from "@/backend/db";
import { redact } from "@/backend/scheduler/pipeline/pii";
import { GitHubError, getPullRequest } from "../github";
import { ToolError, type ToolHandler } from "../session";
import type { IncidentScope } from "./log-tools";

type Pool = ReturnType<typeof createPool>;

export interface RepoTarget {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  testCommands: string[];
}

export type PrAuthorResult =
  | { kind: "pr"; url: string; number: number }
  | { kind: "no_fix"; reason: string };

const recordSchema = z.object({
  pull_number: z.number().int().positive(),
  files_changed: z.array(z.string().max(500)).min(1).max(200),
  validation: z
    .array(z.object({ command: z.string().max(500), exit_code: z.number().int(), output_tail: z.string().max(8_000) }))
    .max(20),
});

/**
 * Host-side tools for the PR author. The agent opens the PR itself through the GitHub MCP
 * server (create_pull_request, approved by githubMcpPolicy in workflow.ts); record_pull_request
 * then re-checks it on GitHub with the backend's own token (draft, branch prefix, base branch,
 * right repository), enforces one PR per investigation, and records it in the database.
 */
export function prAuthorTools(
  pool: Pool,
  scope: IncidentScope,
  repo: RepoTarget,
  branchPrefix: string,
  githubToken: string,
  onDone: (result: PrAuthorResult) => void,
): Record<string, ToolHandler> {
  let done = false;
  let openedUrl: string | undefined;

  return {
    async get_investigation() {
      const { rows } = await pool.query(
        `select v.summary, v.root_cause, v.confidence, v.analysis, i.title, i.service_name, i.environment,
                i.occurrences, i.first_seen, i.last_seen
           from public.investigations v
           join public.incidents i on i.id = v.incident_id
          where v.id = $1 and v.organization_id = $2`,
        [scope.investigationId, scope.organizationId],
      );
      if (!rows[0]) throw new ToolError("Investigation not found.");
      const { rows: events } = await pool.query<{ event_time: Date; message_excerpt: string | null }>(
        `select event_time, message_excerpt from public.incident_events
          where incident_id = $1 and organization_id = $2 order by event_time desc limit 10`,
        [scope.incidentId, scope.organizationId],
      );
      return JSON.stringify({
        ...rows[0],
        title: redact(rows[0].title ?? ""),
        sample_events: events.map((e) => ({ time: e.event_time, message: redact(e.message_excerpt ?? "").slice(0, 2000) })),
      });
    },

    async record_pull_request(input) {
      if (done && openedUrl) {
        // The outcome grader may ask for revisions after the PR exists; pushes to the branch update it.
        return `The draft pull request is already recorded: ${openedUrl}. Push further commits to the same branch to update it.`;
      }
      if (done) throw new ToolError("This task is already finished.");
      const parsed = recordSchema.safeParse(input);
      if (!parsed.success) {
        throw new ToolError(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      const p = parsed.data;

      // Idempotency: one PR per investigation, even across retries.
      const existing = await pool.query<{ url: string; provider_pr_number: number }>(
        `select pr.url, pr.provider_pr_number from public.pull_requests pr
           join public.code_changes cc on cc.id = pr.code_change_id
          where cc.investigation_id = $1 and pr.url is not null limit 1`,
        [scope.investigationId],
      );
      if (existing.rows[0]) {
        done = true;
        openedUrl = existing.rows[0].url;
        onDone({ kind: "pr", url: existing.rows[0].url, number: existing.rows[0].provider_pr_number });
        return `A pull request is already recorded: ${existing.rows[0].url}. You are done.`;
      }

      let pr;
      try {
        pr = await getPullRequest(githubToken, repo.owner, repo.name, p.pull_number);
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) {
          throw new ToolError(`Pull request #${p.pull_number} was not found in ${repo.owner}/${repo.name}. Open it with create_pull_request first.`);
        }
        throw err;
      }
      const fullName = `${repo.owner}/${repo.name}`.toLowerCase();
      if (pr.head.repo?.full_name.toLowerCase() !== fullName) throw new ToolError("The PR head branch must be in the same repository.");
      if (!pr.head.ref.startsWith(branchPrefix)) throw new ToolError(`The PR branch must start with "${branchPrefix}".`);
      if (pr.base.ref !== repo.defaultBranch) throw new ToolError(`The PR must target "${repo.defaultBranch}".`);
      if (!pr.draft) throw new ToolError("The PR must be a draft.");
      if (pr.state !== "open") throw new ToolError("The PR is not open.");

      await withTransaction(pool, async (c) => {
        const cc = await c.query<{ id: string }>(
          `insert into public.code_changes (organization_id, investigation_id, repository_id, patch_ref, diff_summary, files_changed)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [scope.organizationId, scope.investigationId, repo.id, pr.head.ref, pr.title, p.files_changed],
        );
        const codeChangeId = cc.rows[0]!.id;
        const allPassed = p.validation.length > 0 && p.validation.every((v) => v.exit_code === 0);
        await c.query(
          `insert into public.validation_runs (organization_id, code_change_id, status, commands, finished_at)
           values ($1, $2, $3, $4, now())`,
          [scope.organizationId, codeChangeId, allPassed ? "succeeded" : "failed", JSON.stringify(p.validation)],
        );
        await c.query(
          `insert into public.pull_requests
             (organization_id, code_change_id, repository_id, incident_id, provider_pr_number, url, title,
              source_branch, base_branch, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft')`,
          [scope.organizationId, codeChangeId, repo.id, scope.incidentId, pr.number, pr.html_url, pr.title, pr.head.ref, repo.defaultBranch],
        );
      });

      done = true;
      openedUrl = pr.html_url;
      onDone({ kind: "pr", url: pr.html_url, number: pr.number });
      return `Draft pull request recorded: ${pr.html_url}. You are done.`;
    },

    async report_no_fix(input) {
      if (done) throw new ToolError("This task is already finished.");
      const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 4000) : "";
      if (!reason) throw new ToolError("Give a reason.");
      done = true;
      onDone({ kind: "no_fix", reason });
      return "Recorded. You are done.";
    },
  };
}
