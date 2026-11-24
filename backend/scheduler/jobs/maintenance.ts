import type { JobContext } from "../runner";

/** Prunes dedupe state and old run history so tables stay small. */
export function maintenanceJob() {
  return async function run({ pool, cfg }: JobContext) {
    const processed = await pool.query(
      "delete from private.processed_log_events where seen_at < now() - make_interval(hours => $1)",
      [cfg.PROCESSED_EVENT_RETENTION_HOURS],
    );
    const sessions = await pool.query("delete from private.sessions where expires_at < now()");
    const runs = await pool.query(
      "delete from public.scheduler_runs where started_at < now() - make_interval(days => $1)",
      [cfg.SCHEDULER_RUN_RETENTION_DAYS],
    );
    const health = await pool.query(
      "delete from public.connector_health_checks where checked_at < now() - make_interval(days => $1)",
      [cfg.SCHEDULER_RUN_RETENTION_DAYS],
    );
    return {
      processedEventsPruned: processed.rowCount ?? 0,
      sessionsPruned: sessions.rowCount ?? 0,
      runsPruned: runs.rowCount ?? 0,
      healthChecksPruned: health.rowCount ?? 0,
    };
  };
}
