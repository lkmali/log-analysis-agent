import Link from "next/link";
import type { AlertKind, AlertRow, AlertStatus } from "@/backend/db";
import { alertStatusSchema } from "@/backend/validation";
import { canOperate, requireDashboardSession } from "@/lib/session";
import { AlertKindLabel, AlertStatusBadge, SeverityBadge } from "@/components/badges";
import { formatNumber, humanize, timeAgo } from "@/components/format";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionButton } from "@/components/action-button";

export const metadata = { title: "Alerts · Claude SRE" };

const KINDS: AlertKind[] = [
  "pii_detected", "secret_detected", "new_incident", "incident_regression",
  "incident_spike", "connector_error", "scheduler_error",
];

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; kind?: string }>;
}) {
  const { org, role, query } = await requireDashboardSession();
  const params = await searchParams;
  const status: AlertStatus | "all" = params.status === "all" ? "all" : (alertStatusSchema.safeParse(params.status).data ?? "open");
  const kind = KINDS.find((k) => k === params.kind);

  const alerts = await query<AlertRow>(
    `select a.id, a.kind, a.severity, a.status, a.title, a.body, a.occurrences, s.source_name,
            a.first_seen, a.last_seen, a.notified_at
       from public.alerts a left join public.log_sources s on s.id = a.log_source_id
      where a.organization_id = $1
        and ($2::text = 'all' or a.status::text = $2)
        and ($3::text is null or a.kind::text = $3)
      order by a.last_seen desc
      limit 200`,
    [org.id, status, kind ?? null],
  );
  const operate = canOperate(role);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Alerts</h1>
          <p className="muted">PII and secrets in logs, new and spiking errors, CloudWatch and scheduler failures.</p>
        </div>
        <AutoRefresh />
      </div>

      <form className="row" style={{ marginBottom: 16 }} action="/alerts">
        <select name="status" defaultValue={status} aria-label="Status" style={{ width: "auto" }}>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
        <select name="kind" defaultValue={kind ?? ""} aria-label="Type" style={{ width: "auto" }}>
          <option value="">All types</option>
          {KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
        </select>
        <button type="submit" className="btn small">Filter</button>
      </form>

      <div className="table-wrap">
        {alerts.length === 0 ? (
          <div className="empty">No alerts match these filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Severity</th><th>Type</th><th>Alert</th><th>Source</th><th className="num">Count</th>
                <th>First / last seen</th><th>Notified</th><th>Status</th>{operate && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td><SeverityBadge severity={a.severity} /></td>
                  <td><AlertKindLabel kind={a.kind} /></td>
                  <td>
                    {a.title}
                    {a.body && <pre className="body">{a.body}</pre>}
                  </td>
                  <td className="mono">{a.source_name ?? "—"}</td>
                  <td className="num">{formatNumber(a.occurrences)}</td>
                  <td>{timeAgo(a.first_seen)}<div className="muted">{timeAgo(a.last_seen)}</div></td>
                  <td>{a.notified_at ? timeAgo(a.notified_at) : <span className="muted">pending</span>}</td>
                  <td><AlertStatusBadge status={a.status} /></td>
                  {operate && (
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {a.status === "open" && (
                          <ActionButton endpoint={`/api/alerts/${a.id}`} body={{ status: "acknowledged" }} label="Acknowledge" />
                        )}
                        {a.status !== "resolved" ? (
                          <ActionButton endpoint={`/api/alerts/${a.id}`} body={{ status: "resolved" }} label="Resolve" />
                        ) : (
                          <ActionButton endpoint={`/api/alerts/${a.id}`} body={{ status: "open" }} label="Reopen" />
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted">
        Resolving an alert closes it; if the same problem happens again a new alert is opened and notified.
        PII details are in <Link href="/pii">PII Findings</Link>.
      </p>
    </>
  );
}
