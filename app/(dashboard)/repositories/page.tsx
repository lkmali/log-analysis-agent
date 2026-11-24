import type { RepositoryRow } from "@/backend/db";
import { canManage, requireDashboardSession } from "@/lib/session";
import { timeAgo } from "@/components/format";
import { ActionButton } from "@/components/action-button";
import { listAccessibleRepos, type GitHubRepo } from "@/backend/ai/github";
import { getOwnerPool } from "@/backend/db/pools";
import { loadSettings } from "@/backend/settings/store";
import { RegisterRepositoryForm } from "./register-repository-form";
import { GitHubRepos } from "./github-repos";

export const metadata = { title: "Repositories · Claude SRE" };
export const dynamic = "force-dynamic";

/** Repositories visible to the GitHub token saved on the Settings page (owners/admins only). */
async function loadGitHubRepos(): Promise<{ repos: GitHubRepo[] } | { error: string } | undefined> {
  const cfg = await loadSettings(getOwnerPool());
  if (!cfg.GITHUB_TOKEN) return undefined;
  try {
    return { repos: await listAccessibleRepos(cfg.GITHUB_TOKEN) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export default async function RepositoriesPage() {
  const { org, role, query } = await requireDashboardSession();

  const repositories = await query<RepositoryRow>(
    `select r.id, r.owner, r.name, r.default_branch, r.technology, r.services, r.pr_policy, r.enabled, r.updated_at,
            coalesce(array_agg(distinct s.source_name) filter (where s.source_name is not null), '{}') as log_sources
       from public.repositories r
       left join public.repository_mappings m on m.repository_id = r.id
       left join public.log_sources s on s.id = m.log_source_id
      where r.organization_id = $1
      group by r.id
      order by r.owner, r.name`,
    [org.id],
  );
  const manage = canManage(role);
  const github = manage ? await loadGitHubRepos() : undefined;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Repositories</h1>
          <p className="muted">Repositories the agent may investigate and open pull requests against.</p>
        </div>
      </div>

      <div className="table-wrap" style={{ marginBottom: 24 }}>
        {repositories.length === 0 ? (
          <div className="empty">No repositories registered yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Repository</th><th>Default branch</th><th>Services</th><th>Log sources</th>
                <th>Technology</th><th>PR policy</th><th>Updated</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {repositories.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.owner}/{r.name}</td>
                  <td className="mono">{r.default_branch}</td>
                  <td>{r.services.map((s) => <span key={s} className="chip">{s}</span>)}</td>
                  <td>{r.log_sources.map((s) => <div key={s} className="mono">{s}</div>)}</td>
                  <td>{r.technology.map((t) => <span key={t} className="chip">{t}</span>)}</td>
                  <td>{r.pr_policy.replace("_", " ")}</td>
                  <td>{timeAgo(r.updated_at)}</td>
                  <td>
                    <span className={`badge ${r.enabled ? "st-ok" : "st-neutral"}`}>{r.enabled ? "enabled" : "disabled"}</span>
                    {manage && (
                      <div style={{ marginTop: 4 }}>
                        <ActionButton endpoint={`/api/repositories/${r.id}`} body={{ enabled: !r.enabled }}
                                      label={r.enabled ? "Disable" : "Enable"} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {manage && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h2>Your GitHub repositories</h2>
          {!github ? (
            <p className="muted">Save a GitHub token under Settings → AI agents to list the repositories it can access here.</p>
          ) : "error" in github ? (
            <p className="error">Could not list repositories from GitHub: {github.error}</p>
          ) : (
            <GitHubRepos
              repos={github.repos}
              registered={repositories.map((r) => `${r.owner}/${r.name}`.toLowerCase())}
              organizationId={org.id}
              canRegister={manage}
            />
          )}
        </div>
      )}

      {manage ? (
        <div className="card">
          <h2>Register a repository manually</h2>
          <RegisterRepositoryForm organizationId={org.id} />
        </div>
      ) : (
        <p className="muted">Only organization owners and admins can register repositories.</p>
      )}
    </>
  );
}
