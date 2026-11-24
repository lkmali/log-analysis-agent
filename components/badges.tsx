import type { AlertKind, AlertStatus, ConnectorStatus, IncidentStatus, PrStatus, RunStatus, Severity } from "@/backend/db";
import { humanize } from "./format";

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge sev-${severity}`}>{severity}</span>;
}

const INCIDENT_TONE: Record<IncidentStatus, string> = {
  new: "st-bad", investigating: "st-warn", needs_review: "st-warn", resolved: "st-ok", ignored: "st-neutral",
};
export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={`badge ${INCIDENT_TONE[status]}`}>{humanize(status)}</span>;
}

const CONNECTOR_TONE: Record<ConnectorStatus, string> = {
  pending: "st-neutral", connected: "st-ok", degraded: "st-warn", disconnected: "st-bad", disabled: "st-neutral",
};
export function ConnectorStatusBadge({ status }: { status: ConnectorStatus }) {
  return <span className={`badge ${CONNECTOR_TONE[status]}`}>{status}</span>;
}

const PR_TONE: Record<PrStatus, string> = {
  draft: "st-neutral", open: "st-warn", merged: "st-ok", closed: "st-neutral", failed: "st-bad",
};
export function PrStatusBadge({ status }: { status: PrStatus }) {
  return <span className={`badge ${PR_TONE[status]}`}>{status}</span>;
}

const ALERT_TONE: Record<AlertStatus, string> = { open: "st-bad", acknowledged: "st-warn", resolved: "st-ok" };
export function AlertStatusBadge({ status }: { status: AlertStatus }) {
  return <span className={`badge ${ALERT_TONE[status]}`}>{status}</span>;
}

const KIND_LABEL: Record<AlertKind, string> = {
  pii_detected: "PII detected",
  secret_detected: "Secret detected",
  new_incident: "New error",
  incident_regression: "Error returned",
  incident_spike: "Error spike",
  connector_error: "CloudWatch error",
  scheduler_error: "Scheduler error",
};
export function AlertKindLabel({ kind }: { kind: AlertKind }) {
  return <span className="chip">{KIND_LABEL[kind]}</span>;
}

const RUN_TONE: Record<RunStatus, string> = {
  queued: "st-neutral", running: "st-warn", succeeded: "st-ok", failed: "st-bad", cancelled: "st-neutral",
};
export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <span className={`badge ${RUN_TONE[status]}`}>{status}</span>;
}
