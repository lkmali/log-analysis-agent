import Link from "next/link";
import type { AlertRow, OrganizationOverviewRow } from "@/backend/db";
import { requireDashboardSession } from "@/lib/session";
import { AlertKindLabel, AlertStatusBadge, SeverityBadge } from "@/components/badges";
import { formatNumber, formatUsd, timeAgo } from "@/components/format";
import { AutoRefresh } from "@/components/auto-refresh";

export const metadata = { title: "Overview · Claude SRE" };

export default async function OverviewPage() {
  const { org, tx } = await requireDashboardSession();

  const { overview, alerts, heartbeat } = await tx(async (c) => {
    const overview = (await c.query<OrganizationOverviewRow>(
      "select * from public.organization_overview where organization_id = $1", [org.id])).rows[0];
    const alerts = (await c.query<AlertRow>(
      `select a.id, a.kind, a.severity, a.status, a.title, a.body, a.occurrences, s.source_name,
              a.first_seen, a.last_seen, a.notified_at
         from public.alerts a left join public.log_sources s on s.id = a.log_source_id
        where a.organization_id = $1 and a.status = 'open'
        order by a.severity desc, a.last_seen desc limit 8`, [org.id])).rows;
    const heartbeat = (await c.query<{ last: Date | null }>(
      "select max(finished_at) as last from public.scheduler_runs where job = 'cloudwatch-poll' and status = 'succeeded'",
    )).rows[0]?.last ?? null;
    return { overview, alerts, heartbeat };
  });

  const stale = !heartbeat || Date.now() - new Date(heartbeat).getTime() > 5 * 60_000;
  const kpis = [
    { label: "Open alerts", value: formatNumber(overview?.open_alerts) },
    { label: "Open PII / secret alerts", value: formatNumber(overview?.open_pii_alerts) },
    { label: "Open incidents", value: formatNumber(overview?.open_incidents) },
    { label: "Open high/critical", value: formatNumber(overview?.open_high_severity) },
    { label: "Log sources enabled", value: formatNumber(overview?.log_sources_enabled) },
    { label: "Log sources failing", value: formatNumber(overview?.log_sources_failing) },
    { label: "PRs awaiting review", value: formatNumber(overview?.pull_requests_awaiting_review) },
    { label: "Claude spend (30d, est.)", value: formatUsd(overview?.model_cost_usd_30d) },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{org.name}</h1>
          <p className="muted">Production health at a glance.</p>
        </div>
        <AutoRefresh />
      </div>

      {stale && (
        <div className="card banner-bad" style={{ marginBottom: 16 }}>
          <strong>Scheduler not reporting.</strong>{" "}
          {heartbeat ? `Last successful CloudWatch poll ${timeAgo(heartbeat)}.` : "No successful CloudWatch poll recorded yet."}{" "}
          Check the <code>sre-scheduler</code> service on EC2 (<Link href="/system">System Health</Link>).
        </div>
      )}

      <section className="kpis">
        {kpis.map((k) => (
          <div key={k.label} className="kpi">
            <div className="label">{k.label}</div>
            <div className="value">{k.value}</div>
          </div>
        ))}
      </section>

      <h2>Open alerts</h2>
      <div className="table-wrap">
        {alerts.length === 0 ? (
          <div className="empty">No open alerts.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Severity</th><th>Type</th><th>Alert</th><th>Source</th><th className="num">Count</th><th>Last seen</th><th>Status</th></tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td><SeverityBadge severity={a.severity} /></td>
                  <td><AlertKindLabel kind={a.kind} /></td>
                  <td>{a.title}</td>
                  <td className="mono">{a.source_name ?? "—"}</td>
                  <td className="num">{formatNumber(a.occurrences)}</td>
                  <td>{timeAgo(a.last_seen)}</td>
                  <td><AlertStatusBadge status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p><Link href="/alerts">View all alerts →</Link></p>
    </>
  );
}
