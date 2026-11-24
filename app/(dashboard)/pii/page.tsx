import type { PiiFindingRow } from "@/backend/db";
import { requireDashboardSession } from "@/lib/session";
import { SeverityBadge } from "@/components/badges";
import { formatNumber, humanize, timeAgo } from "@/components/format";
import { AutoRefresh } from "@/components/auto-refresh";

export const metadata = { title: "PII Findings · Claude SRE" };

export default async function PiiPage() {
  const { org, query } = await requireDashboardSession();

  const findings = await query<PiiFindingRow>(
    `select f.id, f.pii_type, f.category, f.severity, f.occurrences, f.masked_sample, f.sample_log_stream,
            s.source_name, s.service_name, f.first_seen, f.last_seen
       from public.pii_findings f join public.log_sources s on s.id = f.log_source_id
      where f.organization_id = $1
      order by f.last_seen desc`,
    [org.id],
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>PII &amp; secret findings</h1>
          <p className="muted">
            Sensitive data detected in CloudWatch logs. Values are redacted before storage; only masked samples are kept.
          </p>
        </div>
        <AutoRefresh />
      </div>

      <div className="table-wrap">
        {findings.length === 0 ? (
          <div className="empty">No PII or secrets detected in scanned logs.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Severity</th><th>Type</th><th>Category</th><th>Log group</th><th>Service</th>
                <th>Masked sample</th><th>Sample stream</th><th className="num">Occurrences</th><th>First seen</th><th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id}>
                  <td><SeverityBadge severity={f.severity} /></td>
                  <td>{humanize(f.pii_type)}</td>
                  <td>{f.category === "secret" ? "Secret / credential" : "Personal data"}</td>
                  <td className="mono">{f.source_name}</td>
                  <td>{f.service_name ?? "—"}</td>
                  <td className="mono">{f.masked_sample ?? "—"}</td>
                  <td className="mono">{f.sample_log_stream ?? "—"}</td>
                  <td className="num">{formatNumber(f.occurrences)}</td>
                  <td>{timeAgo(f.first_seen)}</td>
                  <td>{timeAgo(f.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted">
        Fix the logging code that emits these fields, then resolve the matching alert. Sources in “errors only” mode are
        scanned only on error lines; switch a source to “all logs” for full PII coverage.
      </p>
    </>
  );
}
