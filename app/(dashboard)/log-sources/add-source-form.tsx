"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function AddCloudWatchSourceForm({
  organizationId,
  accounts,
  defaultRegion,
}: {
  organizationId: string;
  defaultRegion: string;
  accounts: { id: string; display_name: string; account_id: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // AWS browser state
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [groups, setGroups] = useState<DiscoveredGroup[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (groups ?? []).filter((g) => !q || g.name.toLowerCase().includes(q));
  }, [groups, search]);
  const selectable = visible.filter((g) => !g.added);
  const allVisibleSelected = selectable.length > 0 && selectable.every((g) => selected.has(g.name));

  async function loadGroups() {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    const awsAccountId = String(fd.get("awsAccountId") ?? "");
    setBrowsing(true);
    setBrowseError(null);
    try {
      const res = await fetch("/api/log-sources/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          region: fd.get("region"),
          awsAccountId: awsAccountId || undefined,
          prefix: fd.get("prefix") ?? "",
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        const fe = body?.details?.fieldErrors as Record<string, string[]> | undefined;
        const first = fe && Object.entries(fe)[0];
        setBrowseError(first ? `${first[0]}: ${first[1][0]}`
          : body?.errorName ? `${body.errorName}: ${body.error}` : body?.error ?? "Could not list log groups");
        setGroups(null);
        return;
      }
      setGroups(body.groups);
      setTruncated(!!body.truncated);
      setSelected(new Set());
    } finally {
      setBrowsing(false);
    }
  }

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const g of selectable) {
        if (allVisibleSelected) next.delete(g.name); else next.add(g.name);
      }
      return next;
    });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const awsAccountId = String(fd.get("awsAccountId") ?? "");
    const manual = String(fd.get("logGroup") ?? "").trim();
    const picked = [...selected];
    if (!manual && picked.length === 0) {
      setError("Type a log group name or pick some from AWS.");
      return;
    }
    startTransition(async () => {
      setError(null);
      setNotice(null);
      const res = await fetch("/api/log-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          region: fd.get("region"),
          logGroup: manual || undefined,
          logGroups: picked.length ? picked : undefined,
          serviceName: fd.get("serviceName"),
          environment: fd.get("environment"),
          ingestMode: fd.get("ingestMode"),
          filterPattern: fd.get("filterPattern"),
          piiScan: fd.get("piiScan") === "on",
          pollIntervalSeconds: Number(fd.get("pollIntervalSeconds") || 60),
          awsAccountId: awsAccountId || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const fe = body?.details?.fieldErrors as Record<string, string[]> | undefined;
        const first = fe && Object.entries(fe)[0];
        setError(first ? `${first[0]}: ${first[1][0]}` : body?.error ?? "Could not add log group");
        return;
      }
      const body = await res.json().catch(() => null);
      const added = (body?.ids as string[] | undefined)?.length ?? 1;
      const skipped = (body?.skipped as string[] | undefined) ?? [];
      setNotice(`Added ${added} log group${added === 1 ? "" : "s"}.` +
        (skipped.length ? ` Skipped ${skipped.length} already added.` : ""));
      setGroups((prev) => prev?.map((g) => (selected.has(g.name) || g.name === manual ? { ...g, added: true } : g)) ?? null);
      setSelected(new Set());
      setFormKey((k) => k + 1);
      router.refresh();
    });
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="stack" style={{ maxWidth: 820 }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <label className="field" style={{ flex: 1 }}>
          <span>Region</span>
          <input name="region" required defaultValue={defaultRegion} onChange={() => setGroups(null)} />
        </label>
        <label className="field" style={{ flex: 2 }}>
          <span>AWS credentials</span>
          <select name="awsAccountId" defaultValue="" onChange={() => setGroups(null)}>
            <option value="">EC2 instance role (same account as the scheduler)</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.display_name} ({a.account_id}) — cross-account role</option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="filter-group">
        <legend>Pick log groups from AWS</legend>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 2 }}>
            <span>Name prefix (optional)</span>
            <input name="prefix" placeholder="/ecs/  or  /aws/lambda/" />
          </label>
          <button type="button" className="btn" onClick={loadGroups} disabled={browsing}>
            {browsing ? "Loading…" : groups ? "Reload log groups" : "Load log groups"}
          </button>
        </div>
        {browseError && <p className="error">{browseError}</p>}
        {groups && (
          <div className="stack" style={{ marginTop: 8 }}>
            <div className="row" style={{ alignItems: "center" }}>
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                     placeholder={`Filter ${groups.length} log group(s)…`} style={{ flex: 1 }} />
              <button type="button" className="btn" onClick={toggleAllVisible} disabled={selectable.length === 0}>
                {allVisibleSelected ? "Clear" : `Select all (${selectable.length})`}
              </button>
            </div>
            {visible.length === 0 ? (
              <div className="empty">No log groups match.</div>
            ) : (
              <div className="check-grid" style={{ maxHeight: 320, overflowY: "auto" }}>
                {visible.map((g) => (
                  <label key={g.name} className="check" style={g.added ? { opacity: 0.6 } : undefined}>
                    <input type="checkbox" disabled={g.added}
                           checked={g.added || selected.has(g.name)} onChange={() => toggle(g.name)} />
                    <span className="mono">{g.name}</span>
                    <span className="muted">
                      {g.added ? "already added" : [
                        g.storedBytes != null && formatBytes(g.storedBytes),
                        g.retentionDays ? `${g.retentionDays}d retention` : "never expires",
                      ].filter(Boolean).join(" · ")}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="muted" style={{ margin: 0 }}>
              {selected.size} selected
              {truncated && " · List capped at 2,000 groups — use a prefix to narrow it."}
            </p>
          </div>
        )}
      </fieldset>

      <label className="field" key={formKey}>
        <span>…or type a log group name</span>
        <input name="logGroup" placeholder="/ecs/hospital-api" />
      </label>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <label className="field" style={{ flex: 1 }}>
          <span>Service name</span>
          <input name="serviceName" placeholder="hospital-api" />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Environment</span>
          <input name="environment" placeholder="production" />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Poll every (seconds)</span>
          <input name="pollIntervalSeconds" type="number" min={15} max={3600} defaultValue={60} />
        </label>
      </div>
      <label className="field">
        <span>What to pull</span>
        <select name="ingestMode" defaultValue="errors_only">
          <option value="errors_only">Errors only (ERROR / Exception / FATAL lines) — cheaper</option>
          <option value="all">All logs — full PII coverage, higher volume</option>
        </select>
      </label>
      <label className="field">
        <span>Custom filter pattern (optional)</span>
        <input name="filterPattern" placeholder='{ $.level = "error" }' />
        <small>CloudWatch filter pattern syntax. Overrides the default error pattern in “errors only” mode.</small>
      </label>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" name="piiScan" defaultChecked style={{ width: "auto" }} />
        <span>Scan for PII and secrets and raise alerts</span>
      </label>
      <small className="muted">The settings above apply to every log group you add in this step.</small>
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}
      <div>
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Adding…" : selected.size > 0
            ? `Add ${selected.size} log group${selected.size === 1 ? "" : "s"}` : "Add log group"}
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        The scheduler’s IAM role needs <code>logs:FilterLogEvents</code> on these log groups,{" "}
        <code>logs:DescribeLogGroups</code> to load the list (or <code>sts:AssumeRole</code> for a cross-account role).
      </p>
    </form>
  );
}

interface DiscoveredGroup {
  name: string;
  storedBytes: number | null;
  retentionDays: number | null;
  createdAt: number | null;
  added: boolean;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}
