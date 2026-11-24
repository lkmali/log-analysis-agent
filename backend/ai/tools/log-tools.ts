import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { z } from "zod";
import type { createPool } from "@/backend/db";
import { cloudWatchClient, type AwsBaseCredentials } from "@/backend/scheduler/aws";
import { redact } from "@/backend/scheduler/pipeline/pii";
import { ToolError, type ToolHandler } from "../session";

type Pool = ReturnType<typeof createPool>;

/** Everything the investigator may touch, resolved up front from the incident id. */
export interface IncidentScope {
  incidentId: string;
  organizationId: string;
  investigationId: string;
}

export const investigationSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  observed_facts: z.array(z.string().max(1000)).max(50),
  hypotheses: z
    .array(z.object({ cause: z.string().max(1000), evidence: z.array(z.string().max(1000)).max(20), confidence: z.number().min(0).max(1) }))
    .max(10),
  root_cause: z.string().max(2000),
  confidence: z.number().min(0).max(1),
  fixable_in_code: z.boolean(),
  repository_id: z.string().max(64),
  suspected_files: z.array(z.string().max(500)).max(50),
  recommended_checks: z.array(z.string().max(1000)).max(20),
});
export type InvestigationFindings = z.infer<typeof investigationSchema>;

const MAX_LINE_CHARS = 2_000;
const clampInt = (v: unknown, def: number, min: number, max: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
  return Math.min(max, Math.max(min, n));
};
const cleanLine = (s: string | null | undefined) => redact(s ?? "").slice(0, MAX_LINE_CHARS);

/**
 * Host-side tools for the log investigator. Every query is pinned to the incident's
 * organization: the scheduler pool is the owner role and bypasses RLS, so the scope
 * check here IS the tenant boundary.
 */
export function logInvestigatorTools(
  pool: Pool,
  scope: IncidentScope,
  awsBase: AwsBaseCredentials,
  onSubmit: (findings: InvestigationFindings) => Promise<void>,
): Record<string, ToolHandler> {
  let submitted = false;

  return {
    async get_incident() {
      const { rows } = await pool.query(
        `select i.id, i.title, i.severity, i.status, i.environment, i.service_name, i.occurrences,
                i.first_seen, i.last_seen, s.source_name as log_group, s.service_name as source_service,
                c.region
           from public.incidents i
           left join public.log_sources s on s.id = i.log_source_id
           left join public.log_connectors c on c.id = s.connector_id
          where i.id = $1 and i.organization_id = $2`,
        [scope.incidentId, scope.organizationId],
      );
      const incident = rows[0];
      if (!incident) throw new ToolError("Incident not found.");
      incident.title = cleanLine(incident.title);

      // Candidate repositories: explicitly mapped to this log source/service first, then all enabled repos.
      const { rows: repositories } = await pool.query(
        `select r.id, r.owner || '/' || r.name as full_name, r.default_branch, r.technology, r.services,
                exists (
                  select 1 from public.repository_mappings m
                   where m.repository_id = r.id
                     and (m.log_source_id = i.log_source_id or m.service_name = i.service_name)
                ) or r.id = i.repository_id as mapped
           from public.repositories r
           join public.incidents i on i.id = $1
          where r.organization_id = $2 and r.enabled
          order by mapped desc, r.name
          limit 20`,
        [scope.incidentId, scope.organizationId],
      );
      return JSON.stringify({ incident, candidate_repositories: repositories });
    },

    async list_incident_events(input) {
      const limit = clampInt(input.limit, 20, 1, 50);
      const { rows } = await pool.query<{ event_time: Date; log_stream: string | null; message_excerpt: string | null; request_id: string | null; trace_id: string | null }>(
        `select event_time, log_stream, message_excerpt, request_id, trace_id
           from public.incident_events
          where incident_id = $1 and organization_id = $2
          order by event_time desc
          limit $3`,
        [scope.incidentId, scope.organizationId, limit],
      );
      return JSON.stringify(rows.map((r) => ({ ...r, message_excerpt: cleanLine(r.message_excerpt) })));
    },

    async search_logs(input) {
      const filterPattern = typeof input.filter_pattern === "string" ? input.filter_pattern.slice(0, 1024) : "";
      const before = clampInt(input.minutes_before, 15, 0, 1440);
      const after = clampInt(input.minutes_after, 5, 0, 120);
      const limit = clampInt(input.limit, 50, 1, 100);

      const { rows } = await pool.query<{ log_group: string; region: string; role_arn: string | null; external_id: string | null; last_seen: Date }>(
        `select s.source_name as log_group, c.region, a.role_arn, sec.external_id, i.last_seen
           from public.incidents i
           join public.log_sources s on s.id = i.log_source_id
           join public.log_connectors c on c.id = s.connector_id
           left join public.aws_accounts a on a.id = c.aws_account_id
           left join private.aws_account_secrets sec on sec.aws_account_id = a.id
          where i.id = $1 and i.organization_id = $2 and c.provider = 'cloudwatch'`,
        [scope.incidentId, scope.organizationId],
      );
      const src = rows[0];
      if (!src) throw new ToolError("This incident has no CloudWatch log source to search.");

      const center = src.last_seen.getTime();
      const cw = cloudWatchClient(src.region, src.role_arn, src.external_id, awsBase);
      const lines: Array<{ time: string; stream: string | undefined; message: string }> = [];
      let nextToken: string | undefined;
      try {
        do {
          const res = await cw.send(new FilterLogEventsCommand({
            logGroupName: src.log_group,
            startTime: center - before * 60_000,
            endTime: center + after * 60_000,
            filterPattern: filterPattern || undefined,
            limit: Math.min(limit - lines.length, 100),
            nextToken,
          }));
          for (const e of res.events ?? []) {
            lines.push({ time: new Date(e.timestamp ?? 0).toISOString(), stream: e.logStreamName, message: cleanLine(e.message) });
          }
          nextToken = res.nextToken;
        } while (nextToken && lines.length < limit);
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (e.name === "InvalidParameterException") throw new ToolError(`Invalid filter pattern: ${e.message}`);
        throw err;
      }
      return JSON.stringify({ log_group: src.log_group, count: lines.length, truncated: !!nextToken, lines });
    },

    async submit_investigation(input) {
      if (submitted) throw new ToolError("Findings were already submitted. You are done.");
      const parsed = investigationSchema.safeParse(input);
      if (!parsed.success) {
        throw new ToolError(`Invalid findings: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      const findings = parsed.data;
      if (findings.repository_id) {
        const { rowCount } = await pool.query(
          "select 1 from public.repositories where id::text = $1 and organization_id = $2 and enabled",
          [findings.repository_id, scope.organizationId],
        );
        if (!rowCount) throw new ToolError("repository_id must be the id of one of the candidate repositories, or empty.");
      }
      await onSubmit(findings);
      submitted = true;
      return "Findings recorded. You are done.";
    },
  };
}
