"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/** Sends a PATCH to a write route, then refreshes the page. */
export function ActionButton({
  endpoint,
  body,
  label,
  confirm,
}: {
  endpoint: string;
  body: Record<string, unknown>;
  label: string;
  confirm?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="stack" style={{ gap: 2, display: "inline-flex" }}>
      <button
        type="button"
        className="btn small"
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          startTransition(async () => {
            setError(null);
            const res = await fetch(endpoint, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            if (!res.ok) {
              setError((await res.json().catch(() => null))?.error ?? "Request failed");
              return;
            }
            router.refresh();
          });
        }}
      >
        {pending ? "…" : label}
      </button>
      {error && <span className="error">{error}</span>}
    </span>
  );
}
