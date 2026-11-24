import type { LogSourceRow } from "@/backend/db";
import { canManage, requireDashboardSession } from "@/lib/session";
import { ConnectorStatusBadge } from "@/components/badges";
import { formatNumber, timeAgo } from "@/components/format";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionButton } from "@/components/action-button";
import { AddCloudWatchSourceForm } from "./add-source-form";
import { TestSourceButton } from "./test-source-button";
import { EditSourceButton } from "./edit-source-button";

export const metadata = { title: "Log Sources · Claude SRE" };

export default async function LogSourcesPage() {
  const { org, role, tx } = await requireDashboardSession();

  const { sources, accounts, defaultRegion } = await tx(async (c) => {
    const sources = (await c.query<LogSourceRow>(
      `select s.id, c.name as connector_name, c.provider, c.region, c.status as connector_status,
              s.source_name, s.service_name, s.environment, s.ingest_mode, s.filter_pattern, s.pii_scan,
              s.poll_interval_seconds, s.enabled, s.last_polled_at, s.last_event_at, s.last_error,
              s.events_fetched_total, s.events_new_total, s.errors_detected_total, s.polls_total,
              s.last_poll_fetched, s.last_poll_new, s.last_poll_errors, s.last_poll_pages,
              s.last_poll_window_start, s.last_poll_window_end
         from public.log_sources s join public.log_connectors c on c.id = s.connector_id
        where s.organization_id = $1
        order by c.name, s.source_name`, [org.id])).rows;
    const accounts = (await c.query<{ id: string; display_name: string; account_id: string }>(
      "select id, display_name, account_id from public.aws_accounts where organization_id = $1 order by display_name",
      [org.id])).rows;
    const region = (await c.query<{ value: unknown }>(
      "select value from public.platform_settings where key = 'AWS_REGION'")).rows[0]?.value;
    return { sources, accounts, defaultRegion: typeof region === "string" && region ? region : "ap-south-1" };
  });
  const manage = canManage(role);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Log sources</h1>
          <p className="muted">CloudWatch log groups the EC2 scheduler pulls directly with FilterLogEvents.</p>
        </div>
        <AutoRefresh />
      </div>

      <div className="table-wrap" style={{ marginBottom: 24 }}>
        {sources.length === 0 ? (
          <div className="empty">No log groups yet. Add one below.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Log group</th><th>Connector</th><th>Service / env</th><th>Mode</th><th>PII scan</th>
                <th>Every</th><th>Last poll</th><th title="Fetched = returned by CloudWatch (after filter) · New = not seen before · Errors = became incidents · Skipped = matched the filter but not classified as an error">Scanned (last poll / total)</th><th>Last error event</th><th>Status</th><th>Check CloudWatch</th>{manage && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td className="mono">
                    {s.source_name}
                    {s.filter_pattern && <div className="muted">filter: {s.filter_pattern}</div>}
                    {s.last_error && <div className="error">{s.last_error}</div>}
                  </td>
                  <td>{s.connector_name}<div className="muted">{s.region}</div></td>
                  <td>{s.service_name ?? "—"}<div className="muted">{s.environment ?? ""}</div></td>
                  <td>{s.ingest_mode === "all" ? "All logs" : "Errors only"}</td>
                  <td>{s.pii_scan ? "Yes" : "No"}</td>
                  <td>{s.poll_interval_seconds}s</td>
                  <td>
                    {timeAgo(s.last_polled_at)}
                    {s.last_poll_window_start && s.last_poll_window_end && (
                      <div className="muted">
                        window {new Date(s.last_poll_window_start).toLocaleTimeString()}–
                        {new Date(s.last_poll_window_end).toLocaleTimeString()}
                      </div>
                    )}
                  </td>
                  <td>
                    {s.last_poll_fetched === null ? "—" : (
                      <>
                        <div>
                          {formatNumber(s.last_poll_fetched)} fetched · {formatNumber(s.last_poll_new)} new ·{" "}
                          {formatNumber(s.last_poll_errors)} errors
                        </div>
                        <div className="muted">
                          total {formatNumber(s.events_fetched_total)} fetched · {formatNumber(s.events_new_total)} new ·{" "}
                          {formatNumber(s.errors_detected_total)} errors ·{" "}
                          {formatNumber(Number(s.events_new_total) - Number(s.errors_detected_total))} skipped
                        </div>
                        <div className="muted">{formatNumber(s.polls_total)} polls · {s.last_poll_pages ?? 0} page(s) last poll</div>
                      </>
                    )}
                  </td>
                  <td>{timeAgo(s.last_event_at)}</td>
                  <td>
                    {s.enabled ? <ConnectorStatusBadge status={s.last_error ? "degraded" : s.connector_status} />
                               : <span className="badge st-neutral">disabled</span>}
                  </td>
                  <td><TestSourceButton id={s.id} /></td>
                  {manage && (
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                        <EditSourceButton source={{
                          id: s.id, source_name: s.source_name, region: s.region, connector_name: s.connector_name,
                          service_name: s.service_name, environment: s.environment,
                          ingest_mode: s.ingest_mode === "all" ? "all" : "errors_only",
                          filter_pattern: s.filter_pattern, pii_scan: s.pii_scan,
                          poll_interval_seconds: s.poll_interval_seconds, enabled: s.enabled,
                        }} />
                        <ActionButton endpoint={`/api/log-sources/${s.id}`} body={{ enabled: !s.enabled }}
                                      label={s.enabled ? "Disable" : "Enable"} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {manage ? (
        <div className="card">
          <h2>Add CloudWatch log group</h2>
          <AddCloudWatchSourceForm organizationId={org.id} accounts={accounts} defaultRegion={defaultRegion} />
        </div>
      ) : (
        <p className="muted">Only organization owners and admins can add log sources.</p>
      )}
    </>
  );
}
