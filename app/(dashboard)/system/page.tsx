import type { SchedulerRunRow } from "@/backend/db";
import { requireDashboardSession } from "@/lib/session";
import { RunStatusBadge } from "@/components/badges";
import { timeAgo } from "@/components/format";
import { AutoRefresh } from "@/components/auto-refresh";

export const metadata = { title: "System Health · Claude SRE" };

interface SourceErrorRow {
  source_name: string;
  region: string | null;
  last_error: string;
  last_polled_at: Date | null;
}

export default async function SystemPage() {
  const { org, tx } = await requireDashboardSession();

  const { jobs, failures, sourceErrors } = await tx(async (c) => {
    const jobs = (await c.query<SchedulerRunRow>(
      `select distinct on (job) id, job, host, status, started_at, finished_at, stats, error
         from public.scheduler_runs order by job, started_at desc`)).rows;
    const failures = (await c.query<SchedulerRunRow>(
      `select id, job, host, status, started_at, finished_at, stats, error
         from public.scheduler_runs where status = 'failed' order by started_at desc limit 25`)).rows;
    const sourceErrors = (await c.query<SourceErrorRow>(
      `select s.source_name, c.region, s.last_error, s.last_polled_at
         from public.log_sources s join public.log_connectors c on c.id = s.connector_id
        where s.organization_id = $1 and s.last_error is not null order by s.last_polled_at desc nulls last`,
      [org.id])).rows;
    return { jobs, failures, sourceErrors };
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>System health</h1>
          <p className="muted">EC2 scheduler jobs, CloudWatch polling errors, and recent failures.</p>
        </div>
        <AutoRefresh />
      </div>

      <h2>Scheduler jobs (latest run)</h2>
      <div className="table-wrap" style={{ marginBottom: 24 }}>
        {jobs.length === 0 ? (
          <div className="empty">The scheduler has not run yet. Start the <code>sre-scheduler</code> service on EC2.</div>
        ) : (
          <table>
            <thead><tr><th>Job</th><th>Status</th><th>Host</th><th>Started</th><th>Duration</th><th>Stats</th><th>Error</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="mono">{j.job}</td>
                  <td><RunStatusBadge status={j.status} /></td>
                  <td className="mono">{j.host ?? "—"}</td>
                  <td>{timeAgo(j.started_at)}</td>
                  <td>{j.finished_at ? `${((+new Date(j.finished_at) - +new Date(j.started_at)) / 1000).toFixed(1)}s` : "—"}</td>
                  <td className="mono">{Object.entries(j.stats ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(" ")}</td>
                  <td className="error">{j.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Log sources with errors</h2>
      <div className="table-wrap" style={{ marginBottom: 24 }}>
        {sourceErrors.length === 0 ? (
          <div className="empty">All log sources are polling successfully.</div>
        ) : (
          <table>
            <thead><tr><th>Log group</th><th>Region</th><th>Error</th><th>Last attempt</th></tr></thead>
            <tbody>
              {sourceErrors.map((s) => (
                <tr key={s.source_name}>
                  <td className="mono">{s.source_name}</td>
                  <td>{s.region ?? "—"}</td>
                  <td className="error">{s.last_error}</td>
                  <td>{timeAgo(s.last_polled_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Recent scheduler failures</h2>
      <div className="table-wrap">
        {failures.length === 0 ? (
          <div className="empty">No failed scheduler runs.</div>
        ) : (
          <table>
            <thead><tr><th>Job</th><th>Host</th><th>When</th><th>Error</th></tr></thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.id}>
                  <td className="mono">{f.job}</td>
                  <td className="mono">{f.host ?? "—"}</td>
                  <td>{timeAgo(f.started_at)}</td>
                  <td className="error">{f.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
