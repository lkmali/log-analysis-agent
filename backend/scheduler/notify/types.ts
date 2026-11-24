import type { AlertKind, Severity } from "@/backend/db";

export interface AlertMessage {
  id: string;
  kind: AlertKind;
  severity: Severity;
  title: string;
  body: string | null;
  occurrences: number;
  organizationName: string;
  url: string;
}

export interface Notifier {
  name: string;
  send(alert: AlertMessage): Promise<void>;
}
