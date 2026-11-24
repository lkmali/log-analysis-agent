"use client";

import { useState } from "react";

interface TestResult {
  ok: boolean;
  error?: string;
  errorName?: string;
  logGroup?: string;
  region?: string;
  lookbackMinutes?: number;
  linesInWindow?: number;
  linesInWindowCapped?: boolean;
  matchingFilter?: number;
  matchingFilterCapped?: boolean;
  filterPattern?: string | null;
  latestStream?: { name?: string; lastEventAt: number | null } | null;
  latestStreamError?: string | null;
  samples?: { time: number | null; message: string }[];
}

const fmt = (n = 0, capped = false) => (capped ? `${n}+` : String(n));
const time = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : "—");

/** "Test" button: reads the log group live from CloudWatch and shows what came back. */
export function TestSourceButton({ id }: { id: string }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  async function run() {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch(`/api/log-sources/${id}/test`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as Partial<TestResult> | null;
      // 4xx/5xx from the route come back as { error } without `ok`.
      setResult(body && "ok" in body ? (body as TestResult) : { ok: false, error: body?.error ?? `HTTP ${res.status}` });
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <button type="button" className="btn small" disabled={pending} onClick={run}>
        {pending ? "Testing…" : "Test"}
      </button>
      {result && (
        <div style={{ minWidth: 320, maxWidth: 520, fontSize: 13 }}>
          {!result.ok ? (
            <div className="error">
              ✗ Cannot read CloudWatch{result.errorName ? ` (${result.errorName})` : ""}: {result.error}
            </div>
          ) : (
            <>
              <div>
                {result.linesInWindow
                  ? <strong>✓ Receiving logs</strong>
                  : <strong className="error">✓ Connected, but no log lines in the last {result.lookbackMinutes} min</strong>}
              </div>
              <div>
                Last {result.lookbackMinutes} min: <strong>{fmt(result.linesInWindow, result.linesInWindowCapped)}</strong> lines
                {result.filterPattern !== null && (
                  <> · <strong>{fmt(result.matchingFilter, result.matchingFilterCapped)}</strong> match the error filter</>
                )}
              </div>
              <div className="muted">
                Most active stream: {result.latestStream?.name ?? result.latestStreamError ?? "none"} · sample lines below
                (redacted)
              </div>
              {result.samples && result.samples.length > 0 && (
                <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto", margin: "6px 0 0" }}>
                  {result.samples.map((s) => `${time(s.time)}  ${s.message}`).join("\n")}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
