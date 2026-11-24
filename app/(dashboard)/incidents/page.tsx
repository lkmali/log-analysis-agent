import Link from "next/link";
import type { IncidentRow, Severity } from "@/backend/db";
import { incidentStatusSchema } from "@/backend/validation";
import { requireDashboardSession } from "@/lib/session";
import { IncidentStatusBadge, SeverityBadge } from "@/components/badges";
import { formatNumber, humanize, timeAgo } from "@/components/format";
import { AutoRefresh } from "@/components/auto-refresh";

export const metadata = { title: "Incidents · Claude SRE" };

const PAGE_SIZE = 50;
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; severity?: string; page?: string }>;
}) {
  const { org, query } = await requireDashboardSession();
  const params = await searchParams;
  const status = incidentStatusSchema.safeParse(params.status).data;
  const severity = SEVERITIES.find((s) => s === params.severity);
  const page = Math.max(0, Number.parseInt(params.page ?? "0", 10) || 0);

  const rows = await query<IncidentRow & { total: number }>(
    `select i.id, i.title, i.severity, i.status, i.workflow_state, i.environment, i.service_name,
            r.owner || '/' || r.name as repository, i.first_seen, i.last_seen, i.occurrences,
            count(*) over () as total
       from public.incidents i left join public.repositories r on r.id = i.repository_id
      where i.organization_id = $1
        and ($2::text is null or i.status::text = $2)
        and ($3::text is null or i.severity::text = $3)
      order by i.last_seen desc
      limit $4 offset $5`,
    [org.id, status ?? null, severity ?? null, PAGE_SIZE, page * PAGE_SIZE],
  );
  const total = rows[0]?.total ?? 0;

  const href = (p: number) => {
    const sp = new URLSearchParams();
    if (status) sp.set("status", status);
    if (severity) sp.set("severity", severity);
    if (p > 0) sp.set("page", String(p));
    const qs = sp.toString();
    return qs ? `/incidents?${qs}` : "/incidents";
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Incidents</h1>
          <p className="muted">{formatNumber(total)} grouped errors from CloudWatch</p>
        </div>
        <AutoRefresh />
      </div>

      <form className="row" style={{ marginBottom: 16 }} action="/incidents">
        <select name="status" defaultValue={status ?? ""} aria-label="Status" style={{ width: "auto" }}>
          <option value="">All statuses</option>
          {incidentStatusSchema.options.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </select>
        <select name="severity" defaultValue={severity ?? ""} aria-label="Severity" style={{ width: "auto" }}>
          <option value="">All severities</option>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button type="submit" className="btn small">Filter</button>
      </form>

      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty">No incidents match these filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Severity</th><th>Title</th><th>Service / repository</th><th>Env</th><th>Status</th>
                <th className="num">Occurrences</th><th>First seen</th><th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td><SeverityBadge severity={i.severity} /></td>
                  <td>{i.title}</td>
                  <td>
                    {i.service_name ?? "—"}
                    {i.repository && <div className="muted mono">{i.repository}</div>}
                  </td>
                  <td>{i.environment ?? "—"}</td>
                  <td><IncidentStatusBadge status={i.status} /></td>
                  <td className="num">{formatNumber(i.occurrences)}</td>
                  <td>{timeAgo(i.first_seen)}</td>
                  <td>{timeAgo(i.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
        {page > 0 ? <Link href={href(page - 1)}>← Newer</Link> : <span />}
        {(page + 1) * PAGE_SIZE < total && <Link href={href(page + 1)}>Older →</Link>}
      </div>
    </>
  );
}
