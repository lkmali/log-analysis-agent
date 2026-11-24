import type { AlertKind, PoolClient, Severity } from "@/backend/db";

export interface AlertInput {
  organizationId: string;
  kind: AlertKind;
  severity: Severity;
  title: string;
  body?: string;           // must never contain raw PII / secrets
  dedupKey: string;
  occurrences?: number;
  incidentId?: string | null;
  logSourceId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Opens an alert, or folds into the existing open/acknowledged alert with the
 * same dedup key (occurrences += n, severity can only go up). Returns true when
 * a NEW alert was created (it will then be notified by the dispatcher).
 */
export async function raiseAlert(client: PoolClient, a: AlertInput): Promise<boolean> {
  const { rows } = await client.query<{ inserted: boolean }>(
    `insert into public.alerts (organization_id, kind, severity, title, body, dedup_key, occurrences,
                                incident_id, log_source_id, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (organization_id, dedup_key) where status <> 'resolved'
     do update set occurrences = public.alerts.occurrences + excluded.occurrences,
                   last_seen   = now(),
                   severity    = greatest(public.alerts.severity, excluded.severity),
                   title       = excluded.title,
                   body        = excluded.body,
                   details     = excluded.details
     returning (xmax = 0) as inserted`,
    [a.organizationId, a.kind, a.severity, a.title.slice(0, 300), a.body?.slice(0, 4000) ?? null, a.dedupKey,
     a.occurrences ?? 1, a.incidentId ?? null, a.logSourceId ?? null, JSON.stringify(a.details ?? {})],
  );
  return rows[0]?.inserted ?? false;
}

/** Auto-resolves open alerts once the underlying problem is gone (e.g. polling works again). */
export async function resolveAlerts(client: PoolClient, organizationId: string | null, dedupKey: string) {
  await client.query(
    `update public.alerts set status = 'resolved', resolved_at = now()
      where dedup_key = $1 and status <> 'resolved' and ($2::uuid is null or organization_id = $2)`,
    [dedupKey, organizationId],
  );
}
