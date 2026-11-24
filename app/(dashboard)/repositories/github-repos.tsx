"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { GitHubRepo } from "@/backend/ai/github";

/** Repositories the saved GitHub token can access, with search and one-click registration. */
export function GitHubRepos({
  repos,
  registered,
  organizationId,
  canRegister,
}: {
  repos: GitHubRepo[];
  /** "owner/name" lowercased, already registered in this organization. */
  registered: string[];
  organizationId: string;
  canRegister: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [pendingRepo, setPendingRepo] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();
  const done = useMemo(() => new Set(registered), [registered]);

  const visible = repos.filter((r) =>
    (showArchived || !r.archived) &&
    (!filter || `${r.fullName} ${r.description ?? ""} ${r.language ?? ""}`.toLowerCase().includes(filter.toLowerCase())));

  function register(r: GitHubRepo) {
    setPendingRepo(r.fullName);
    startTransition(async () => {
      const res = await fetch("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          owner: r.owner,
          name: r.name,
          defaultBranch: r.defaultBranch,
          technology: r.language ? [r.language.toLowerCase()] : [],
          services: [],
          testCommands: [],
          prPolicy: "approval_required",
        }),
      });
      setPendingRepo(null);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setErrors((e) => ({ ...e, [r.fullName]: body?.error ?? "Registration failed" }));
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="stack">
      <div className="row">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, description or language"
               aria-label="Filter repositories" style={{ flex: "1 1 240px", width: "auto" }} />
        <label className="check inline">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          <span>Show archived</span>
        </label>
        <span className="muted">{visible.length} of {repos.length}</span>
      </div>
      <div className="table-wrap" style={{ maxHeight: 520, overflowY: "auto" }}>
        {visible.length === 0 ? (
          <div className="empty">No repositories match.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Repository</th><th>Default branch</th><th>Language</th><th>Last push</th><th /></tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const isRegistered = done.has(r.fullName.toLowerCase());
                return (
                  <tr key={r.id}>
                    <td>
                      <a className="mono" href={r.htmlUrl} target="_blank" rel="noreferrer">{r.fullName}</a>
                      {" "}<span className="chip">{r.private ? "private" : "public"}</span>
                      {r.archived && <span className="chip">archived</span>}
                      {r.description && <div className="muted">{r.description}</div>}
                    </td>
                    <td className="mono">{r.defaultBranch}</td>
                    <td>{r.language ?? "—"}</td>
                    <td>{r.pushedAt ? new Date(r.pushedAt).toLocaleDateString() : "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {isRegistered ? (
                        <span className="badge st-ok">registered</span>
                      ) : canRegister ? (
                        <button type="button" className="btn small" disabled={pendingRepo !== null || r.archived}
                                onClick={() => register(r)}>
                          {pendingRepo === r.fullName ? "Registering…" : "Register"}
                        </button>
                      ) : null}
                      {errors[r.fullName] && <div className="error">{errors[r.fullName]}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
