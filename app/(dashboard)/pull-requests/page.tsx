import type { PullRequestRow } from "@/backend/db";
import { requireDashboardSession } from "@/lib/session";
import { PrStatusBadge } from "@/components/badges";
import { timeAgo } from "@/components/format";

export const metadata = { title: "Pull Requests · Claude SRE" };

export default async function PullRequestsPage() {
  const { org, query } = await requireDashboardSession();

  const prs = await query<PullRequestRow>(
    `select p.id, p.title, p.url, p.provider_pr_number, p.source_branch, p.base_branch, p.status,
            r.owner || '/' || r.name as repository, i.title as incident_title, p.updated_at
       from public.pull_requests p
       left join public.repositories r on r.id = p.repository_id
       left join public.incidents i on i.id = p.incident_id
      where p.organization_id = $1
      order by p.created_at desc limit 100`,
    [org.id],
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Pull requests</h1>
          <p className="muted">Every PR raised by the platform. PRs are never merged automatically.</p>
        </div>
      </div>
      <div className="table-wrap">
        {prs.length === 0 ? (
          <div className="empty">No pull requests yet. They appear here once PR automation is enabled (Phase 6).</div>
        ) : (
          <table>
            <thead><tr><th>Pull request</th><th>Repository</th><th>Branch</th><th>Incident</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {prs.map((pr) => (
                <tr key={pr.id}>
                  <td>
                    {pr.url ? (
                      <a href={pr.url} target="_blank" rel="noreferrer noopener">
                        {pr.title}{pr.provider_pr_number != null && ` #${pr.provider_pr_number}`}
                      </a>
                    ) : pr.title}
                  </td>
                  <td className="mono">{pr.repository ?? "—"}</td>
                  <td className="mono">{pr.source_branch} → {pr.base_branch}</td>
                  <td>{pr.incident_title ?? "—"}</td>
                  <td><PrStatusBadge status={pr.status} /></td>
                  <td>{timeAgo(pr.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
