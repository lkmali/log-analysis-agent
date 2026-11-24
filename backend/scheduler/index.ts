import { aiInvestigateJob } from "@/backend/ai/job";
import { closeOwnerPool, getOwnerPool } from "@/backend/db/pools";
import { loadSettings } from "@/backend/settings/store";
import { destroyAwsClients } from "./aws";
import { toSchedulerConfig } from "./config";
import { alertDispatchJob } from "./jobs/alert-dispatch";
import { cloudWatchPollJob } from "./jobs/cloudwatch-poll";
import { maintenanceJob } from "./jobs/maintenance";
import { createLogger, errorMessage } from "./logger";
import { JobRunner, type JobDefinition } from "./runner";

const globalForScheduler = globalThis as unknown as { sreSchedulerStarted?: boolean };

/**
 * Starts the background jobs inside the web server process (called from instrumentation.ts).
 * Uses the owner-role pool (same database as the dashboard, built from the SQL_* settings).
 * All job settings come from the Settings page and are reloaded before every run.
 */
export async function startScheduler() {
  if (globalForScheduler.sreSchedulerStarted) return; // dev hot reload / double register
  globalForScheduler.sreSchedulerStarted = true;

  let level: "debug" | "info" | "warn" | "error" = "info";
  const log = createLogger(() => level, { service: "sre-scheduler" });

  let pool;
  let initial;
  try {
    pool = getOwnerPool();
    initial = toSchedulerConfig(await loadSettings(pool, { fresh: true })); // fails fast on bad DB settings
  } catch (err) {
    // Don't take the web server down with us; the dashboard can still run.
    log.error("scheduler not started: cannot load settings from the database", { error: errorMessage(err) });
    globalForScheduler.sreSchedulerStarted = false;
    await closeOwnerPool().catch(() => {});
    return;
  }
  level = initial.LOG_LEVEL;

  const loadConfig = async () => {
    const cfg = toSchedulerConfig(await loadSettings(pool));
    level = cfg.LOG_LEVEL;
    return cfg;
  };

  const jobs: JobDefinition[] = [
    { name: "cloudwatch-poll", intervalSeconds: (c) => c.CW_TICK_SECONDS, run: cloudWatchPollJob() },
    { name: "alert-dispatch", intervalSeconds: (c) => c.ALERT_DISPATCH_SECONDS, run: alertDispatchJob() },
    { name: "maintenance", intervalSeconds: () => 3600, run: maintenanceJob() },
    { name: "ai-investigate", intervalSeconds: (c) => c.AI_TICK_SECONDS, run: aiInvestigateJob() },
  ];

  const runner = new JobRunner(pool, log, loadConfig);
  runner.start(jobs, initial);
  log.info("scheduler started", { jobs: jobs.map((j) => j.name) });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("scheduler shutting down", { signal });
    await runner.stop();
    destroyAwsClients();
    await closeOwnerPool();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
