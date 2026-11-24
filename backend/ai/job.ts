import { SEVERITY_ORDER, withTransaction, type Severity } from "@/backend/db";
import { errorMessage } from "@/backend/scheduler/logger";
import type { JobContext } from "@/backend/scheduler/runner";
import { aiReady } from "./config";
import { runIncidentWorkflow } from "./workflow";

const severitiesAtLeast = (min: Severity) =>
  (Object.keys(SEVERITY_ORDER) as Severity[]).filter((s) => SEVERITY_ORDER[s] >= SEVERITY_ORDER[min]);

/**
 * Scheduler job: claims new incidents (severity >= AI_INVESTIGATE_MIN_SEVERITY) that have
 * no investigation yet and runs the AI workflow on each. Claiming happens in one transaction
 * with SKIP LOCKED + an investigations row, so an incident is never picked up twice.
 */
export function aiInvestigateJob() {
  return async function run({ pool, log, cfg }: JobContext) {
    if (!aiReady(cfg)) return { skipped: "AI agents not enabled or not provisioned (Settings → AI agents)" };
    const severities = severitiesAtLeast(cfg.AI_INVESTIGATE_MIN_SEVERITY);

    const claimed = await withTransaction(pool, async (c) => {
      const { rows } = await c.query<{ id: string; organization_id: string }>(
        `select i.id, i.organization_id
           from public.incidents i
          where i.status = 'new'
            and i.workflow_state in ('GROUPED', 'TRIAGED')
            and i.severity = any($1::public.severity[])
            and i.log_source_id is not null
            and not exists (select 1 from public.investigations v where v.incident_id = i.id)
          order by i.severity desc, i.last_seen desc
          limit $2
          for update of i skip locked`,
        [severities, cfg.AI_INCIDENTS_PER_TICK],
      );
      const out: Array<{ incidentId: string; organizationId: string; investigationId: string }> = [];
      for (const r of rows) {
        const v = await c.query<{ id: string }>(
          `insert into public.investigations (organization_id, incident_id, status)
           values ($1, $2, 'INVESTIGATING') returning id`,
          [r.organization_id, r.id],
        );
        await c.query(
          "update public.incidents set status = 'investigating', workflow_state = 'INVESTIGATING' where id = $1",
          [r.id],
        );
        out.push({ incidentId: r.id, organizationId: r.organization_id, investigationId: v.rows[0]!.id });
      }
      return out;
    });

    let failed = 0;
    for (const scope of claimed) {
      try {
        await runIncidentWorkflow(pool, log, cfg, scope);
      } catch (err) {
        failed++;
        log.error("AI workflow failed", { incidentId: scope.incidentId, error: errorMessage(err) });
        await pool.query("update public.investigations set status = 'FAILED' where id = $1", [scope.investigationId]);
        await pool.query(
          "update public.incidents set workflow_state = 'FAILED', status = 'needs_review' where id = $1",
          [scope.incidentId],
        );
      }
    }
    return { claimed: claimed.length, failed };
  };
}
