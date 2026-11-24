import os from "node:os";
import type { createPool } from "@/backend/db";
import { withTransaction } from "@/backend/db";
import { raiseAlert, resolveAlerts } from "./alerts";
import type { Config } from "./config";
import { errorMessage, type Logger } from "./logger";

type Pool = ReturnType<typeof createPool>;

export interface JobContext {
  pool: Pool;
  log: Logger;
  /** Current platform settings, reloaded before every run. */
  cfg: Config;
}

export interface JobDefinition {
  name: string;
  /** Evaluated after every run, so interval changes on the Settings page apply without a restart. */
  intervalSeconds: (cfg: Config) => number;
  run: (ctx: JobContext) => Promise<Record<string, unknown>>;
}

/**
 * Runs jobs on fixed intervals. Each run:
 *  - takes a PostgreSQL advisory lock, so if two EC2 instances run the scheduler
 *    only one executes a given job at a time;
 *  - is recorded in public.scheduler_runs (visible on the System Health page);
 *  - raises a scheduler_error alert on failure, auto-resolved on the next success.
 */
export class JobRunner {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Map<string, Promise<void>>();
  private stopping = false;
  private readonly host = os.hostname();

  private lastConfig?: Config;

  constructor(private pool: Pool, private log: Logger, private loadConfig: () => Promise<Config>) {}

  start(jobs: JobDefinition[], initialConfig: Config) {
    this.lastConfig = initialConfig;
    for (const job of jobs) {
      const tick = () => {
        if (this.stopping) return;
        if (!this.running.has(job.name)) {
          const p = this.execute(job).finally(() => this.running.delete(job.name));
          this.running.set(job.name, p);
        }
        const seconds = this.lastConfig ? job.intervalSeconds(this.lastConfig) : 30;
        this.timers.set(job.name, setTimeout(tick, seconds * 1000));
      };
      // Stagger first runs slightly.
      this.timers.set(job.name, setTimeout(tick, 1000 + Math.random() * 2000));
    }
  }

  async stop() {
    this.stopping = true;
    for (const t of this.timers.values()) clearTimeout(t);
    await Promise.allSettled(this.running.values());
  }

  private async execute(job: JobDefinition) {
    const log = this.log.child({ job: job.name });
    const lockClient = await this.pool.connect();
    let runId: number | undefined;
    try {
      const { rows } = await lockClient.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)) as locked", [`claude-sre:${job.name}`]);
      if (!rows[0]?.locked) {
        log.debug("another scheduler instance holds the lock; skipping");
        return;
      }
      try {
        runId = (await this.pool.query<{ id: number }>(
          "insert into public.scheduler_runs (job, host) values ($1, $2) returning id", [job.name, this.host],
        )).rows[0]!.id;

        const cfg = await this.loadConfig();
        this.lastConfig = cfg;
        const stats = await job.run({ pool: this.pool, log, cfg });
        await this.pool.query(
          "update public.scheduler_runs set status = 'succeeded', finished_at = now(), stats = $2 where id = $1",
          [runId, JSON.stringify(stats)],
        );
        await withTransaction(this.pool, (c) => resolveAlerts(c, null, `scheduler:${job.name}`));
        log.info("job succeeded", stats);
      } finally {
        await lockClient.query("select pg_advisory_unlock(hashtext($1))", [`claude-sre:${job.name}`]);
      }
    } catch (err) {
      const message = errorMessage(err);
      log.error("job failed", { error: message });
      try {
        if (runId) {
          await this.pool.query(
            "update public.scheduler_runs set status = 'failed', finished_at = now(), error = $2 where id = $1",
            [runId, message],
          );
        }
        await withTransaction(this.pool, async (c) => {
          const { rows: orgs } = await c.query<{ id: string }>("select id from public.organizations");
          for (const org of orgs) {
            await raiseAlert(c, {
              organizationId: org.id, kind: "scheduler_error", severity: "high",
              title: `Scheduler job "${job.name}" is failing`,
              body: `${message}\nHost: ${this.host}`,
              dedupKey: `scheduler:${job.name}`,
            });
          }
        });
      } catch (recordErr) {
        log.error("could not record job failure", { error: errorMessage(recordErr) });
      }
    } finally {
      lockClient.release();
    }
  }
}
