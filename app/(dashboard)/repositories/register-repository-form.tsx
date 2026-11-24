"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const list = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

export function RegisterRepositoryForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const installation = String(fd.get("installationId") ?? "").trim();

    startTransition(async () => {
      setError(null);
      const res = await fetch("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          owner: fd.get("owner"),
          name: fd.get("name"),
          defaultBranch: fd.get("defaultBranch") || "main",
          installationId: installation ? Number(installation) : undefined,
          technology: list(fd.get("technology")),
          services: list(fd.get("services")),
          testCommands: list(fd.get("testCommands")),
          prPolicy: fd.get("prPolicy"),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const fieldErrors = body?.details?.fieldErrors as Record<string, string[]> | undefined;
        const firstField = fieldErrors && Object.entries(fieldErrors)[0];
        setError(firstField ? `${firstField[0]}: ${firstField[1][0]}` : body?.error ?? "Registration failed");
        return;
      }
      setFormKey((k) => k + 1);
      router.refresh();
    });
  }

  return (
    <form key={formKey} onSubmit={onSubmit} className="stack" style={{ maxWidth: 640 }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <label className="field" style={{ flex: 1 }}>
          <span>GitHub owner</span>
          <input name="owner" required placeholder="example-company" />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Repository name</span>
          <input name="name" required placeholder="hospital-backend" />
        </label>
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <label className="field" style={{ flex: 1 }}>
          <span>Default branch</span>
          <input name="defaultBranch" defaultValue="main" />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>GitHub App installation ID</span>
          <input name="installationId" inputMode="numeric" pattern="[0-9]*" placeholder="Optional for now" />
        </label>
      </div>
      <label className="field">
        <span>Services</span>
        <input name="services" placeholder="hospital-api, patient-worker" />
        <small>Comma-separated service names used to map incidents to this repository.</small>
      </label>
      <label className="field">
        <span>Technology</span>
        <input name="technology" placeholder="nodejs, nestjs, typescript" />
      </label>
      <label className="field">
        <span>Approved validation commands</span>
        <textarea name="testCommands" rows={3} placeholder={"npm ci\nnpm test\nnpm run lint"} />
        <small>One per line. Only npm/pnpm/yarn ci, install, test, or run &lt;script&gt; are allowed.</small>
      </label>
      <label className="field">
        <span>Pull request policy</span>
        <select name="prPolicy" defaultValue="approval_required">
          <option value="approval_required">Approval required</option>
          <option value="draft_only">Draft PRs only</option>
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <div>
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Registering…" : "Register repository"}
        </button>
      </div>
    </form>
  );
}
