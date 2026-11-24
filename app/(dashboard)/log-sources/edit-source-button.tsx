"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface EditableSource {
  id: string;
  source_name: string;
  region: string | null;
  connector_name: string;
  service_name: string | null;
  environment: string | null;
  ingest_mode: "errors_only" | "all";
  filter_pattern: string | null;
  pii_scan: boolean;
  poll_interval_seconds: number;
  enabled: boolean;
}

/** "Edit" button: opens a dialog to change a log source's settings. */
export function EditSourceButton({ source }: { source: EditableSource }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  function open() {
    setError(null);
    setFormKey((k) => k + 1); // reset fields to the current saved values
    dialogRef.current?.showModal();
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      setError(null);
      const res = await fetch(`/api/log-sources/${source.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceName: fd.get("serviceName") ?? "",
          environment: fd.get("environment") ?? "",
          ingestMode: fd.get("ingestMode"),
          filterPattern: fd.get("filterPattern") ?? "",
          piiScan: fd.get("piiScan") === "on",
          pollIntervalSeconds: Number(fd.get("pollIntervalSeconds") || 60),
          enabled: fd.get("enabled") === "on",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const fe = body?.details?.fieldErrors as Record<string, string[]> | undefined;
        const first = fe && Object.entries(fe)[0];
        setError(first ? `${first[0]}: ${first[1][0]}` : body?.error ?? "Could not save");
        return;
      }
      dialogRef.current?.close();
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="btn small" onClick={open}>Edit</button>
      <dialog ref={dialogRef} className="card" style={{ width: "min(640px, calc(100vw - 32px))", padding: 24 }}
              onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
        <form key={formKey} onSubmit={onSubmit} className="stack">
          <div>
            <h2 style={{ margin: 0 }}>Edit log source</h2>
            <p className="mono" style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>{source.source_name}</p>
            <p className="muted" style={{ margin: 0 }}>
              {source.connector_name}. Region and credentials can’t be changed; add the group again to move it.
            </p>
          </div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <label className="field" style={{ flex: 1 }}>
              <span>Service name</span>
              <input name="serviceName" defaultValue={source.service_name ?? ""} placeholder="hospital-api" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Environment</span>
              <input name="environment" defaultValue={source.environment ?? ""} placeholder="production" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Poll every (seconds)</span>
              <input name="pollIntervalSeconds" type="number" min={15} max={3600}
                     defaultValue={source.poll_interval_seconds} />
            </label>
          </div>
          <label className="field">
            <span>What to pull</span>
            <select name="ingestMode" defaultValue={source.ingest_mode}>
              <option value="errors_only">Errors only (ERROR / Exception / FATAL lines) — cheaper</option>
              <option value="all">All logs — full PII coverage, higher volume</option>
            </select>
          </label>
          <label className="field">
            <span>Custom filter pattern (optional)</span>
            <input name="filterPattern" defaultValue={source.filter_pattern ?? ""} placeholder='{ $.level = "error" }' />
            <small>Leave empty to use the default error pattern in “errors only” mode.</small>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" name="piiScan" defaultChecked={source.pii_scan} style={{ width: "auto" }} />
            <span>Scan for PII and secrets and raise alerts</span>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" name="enabled" defaultChecked={source.enabled} style={{ width: "auto" }} />
            <span>Enabled (the scheduler polls this log group)</span>
          </label>
          {error && <p className="error">{error}</p>}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => dialogRef.current?.close()} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
