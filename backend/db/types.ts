/** Row shapes mirroring db/migrations/*.sql. node-postgres returns timestamptz as Date. */

export type OrgRole = "owner" | "admin" | "member" | "viewer";
export type Severity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "new" | "investigating" | "needs_review" | "resolved" | "ignored";
export type ConnectorStatus = "pending" | "connected" | "degraded" | "disconnected" | "disabled";
export type LogProvider = "cloudwatch" | "elasticsearch" | "cloudfront" | "datadog";
export type IngestMode = "errors_only" | "all";
export type PrPolicy = "draft_only" | "approval_required";
export type PrStatus = "draft" | "open" | "merged" | "closed" | "failed";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AlertKind =
  | "pii_detected"
  | "secret_detected"
  | "new_incident"
  | "incident_regression"
  | "incident_spike"
  | "connector_error"
  | "scheduler_error";
export type AlertStatus = "open" | "acknowledged" | "resolved";
export type SensitiveCategory = "pii" | "secret";
export type WorkflowState =
  | "RECEIVED"
  | "NORMALIZED"
  | "GROUPED"
  | "TRIAGED"
  | "INVESTIGATING"
  | "REPOSITORY_RESOLVED"
  | "PATCH_PROPOSED"
  | "VALIDATING"
  | "AWAITING_APPROVAL"
  | "PR_CREATED"
  | "NEEDS_HUMAN_REVIEW"
  | "DUPLICATE"
  | "IGNORED"
  | "FAILED"
  | "CANCELLED";

export const SEVERITY_ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
}

export interface MembershipRow extends OrganizationRow {
  role: OrgRole;
}

export interface RepositoryRow {
  id: string;
  owner: string;
  name: string;
  default_branch: string;
  technology: string[];
  services: string[];
  pr_policy: PrPolicy;
  enabled: boolean;
  updated_at: Date;
  log_sources: string[];
}

export interface LogSourceRow {
  id: string;
  connector_name: string;
  provider: LogProvider;
  region: string | null;
  connector_status: ConnectorStatus;
  source_name: string;
  service_name: string | null;
  environment: string | null;
  ingest_mode: IngestMode;
  filter_pattern: string | null;
  pii_scan: boolean;
  poll_interval_seconds: number;
  enabled: boolean;
  last_polled_at: Date | null;
  last_event_at: Date | null;
  last_error: string | null;
  events_fetched_total: string; // bigint → string from pg
  events_new_total: string;
  errors_detected_total: string;
  polls_total: string;
  last_poll_fetched: number | null;
  last_poll_new: number | null;
  last_poll_errors: number | null;
  last_poll_pages: number | null;
  last_poll_window_start: Date | null;
  last_poll_window_end: Date | null;
}

export interface IncidentRow {
  id: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  workflow_state: WorkflowState;
  environment: string | null;
  service_name: string | null;
  repository: string | null;
  first_seen: Date;
  last_seen: Date;
  occurrences: number;
}

export interface PullRequestRow {
  id: string;
  title: string;
  url: string | null;
  provider_pr_number: number | null;
  source_branch: string;
  base_branch: string;
  status: PrStatus;
  repository: string | null;
  incident_title: string | null;
  updated_at: Date;
}

export interface AlertRow {
  id: string;
  kind: AlertKind;
  severity: Severity;
  status: AlertStatus;
  title: string;
  body: string | null;
  occurrences: number;
  source_name: string | null;
  first_seen: Date;
  last_seen: Date;
  notified_at: Date | null;
}

export interface PiiFindingRow {
  id: string;
  pii_type: string;
  category: SensitiveCategory;
  severity: Severity;
  occurrences: number;
  masked_sample: string | null;
  sample_log_stream: string | null;
  source_name: string;
  service_name: string | null;
  first_seen: Date;
  last_seen: Date;
}

export interface SchedulerRunRow {
  id: number;
  job: string;
  host: string | null;
  status: RunStatus;
  started_at: Date;
  finished_at: Date | null;
  stats: Record<string, unknown>;
  error: string | null;
}

export interface OrganizationOverviewRow {
  open_incidents: number;
  open_high_severity: number;
  open_alerts: number;
  open_pii_alerts: number;
  pull_requests_awaiting_review: number;
  repositories_enabled: number;
  log_sources_enabled: number;
  log_sources_failing: number;
  model_tokens_30d: number;
  model_cost_usd_30d: string;
}
