/**
 * Minimal GitHub REST client for the backend's own reads: listing the repositories the
 * token can see (Repositories page) and verifying pull requests the PR author agent
 * opened through the GitHub MCP server. The agent itself never sees this token.
 */

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function gh<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "loger-agents",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GitHubError(res.status, `GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export interface GitHubRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  language: string | null;
  description: string | null;
  htmlUrl: string;
  pushedAt: string | null;
}

interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  archived: boolean;
  default_branch: string;
  language: string | null;
  description: string | null;
  html_url: string;
  pushed_at: string | null;
}

const MAX_REPO_PAGES = 5; // 500 repositories

/** Repositories the token can access (owned, collaborator, and organization member), most recently pushed first. */
export async function listAccessibleRepos(token: string): Promise<GitHubRepo[]> {
  const out: GitHubRepo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const batch = await gh<RawRepo[]>(
      token, "GET",
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    );
    for (const r of batch) {
      out.push({
        id: r.id, owner: r.owner.login, name: r.name, fullName: r.full_name, private: r.private,
        archived: r.archived, defaultBranch: r.default_branch, language: r.language,
        description: r.description, htmlUrl: r.html_url, pushedAt: r.pushed_at,
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

export interface PullRequestInfo {
  number: number;
  html_url: string;
  title: string;
  draft: boolean;
  state: string;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
}

export function getPullRequest(token: string, owner: string, repo: string, number: number) {
  return gh<PullRequestInfo>(token, "GET", `/repos/${owner}/${repo}/pulls/${number}`);
}
