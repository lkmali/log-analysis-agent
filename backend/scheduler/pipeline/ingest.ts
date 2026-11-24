import type { PoolClient, Severity } from "@/backend/db";
import { raiseAlert } from "../alerts";
import { severityRank } from "../config";
import { fingerprintError } from "./fingerprint";
import { parseLogMessage } from "./normalize";
import { SENSITIVE_LABEL, scanSensitive, type Finding, type SensitiveType } from "./pii";

export interface SourceContext {
  id: string;
  organizationId: string;
  sourceName: string;
  serviceName: string | null;
  environment: string | null;
  piiScan: boolean;
}

export interface RawEvent {
  eventId: string;
  timestamp: number;
  logStream?: string;
  message: string;
}

export interface IngestOptions {
  enabledTypes: ReadonlySet<SensitiveType>;
  maxSamplesPerIncident: number;
  newIncidentMinSeverity: Severity;
  spikeThreshold: number;
}

interface ErrorGroup {
  fingerprint: string;
  title: string;
  severity: Severity;
  service: string | null;
  count: number;
  first: Date;
  last: Date;
  samples: { time: Date; stream?: string; eventId: string; message: string; requestId?: string; traceId?: string }[];
}

interface PiiAggregate extends Finding {
  stream?: string;
  eventId: string;
}

export interface IngestStats {
  events: number;
  errors: number;
  incidentsTouched: number;
  newIncidents: number;
  piiEvents: number;
  alertsOpened: number;
}

const maxSeverity = (a: Severity, b: Severity) => (severityRank[a] >= severityRank[b] ? a : b);
const EXCERPT_CHARS = 4000;

/** Pure step: redact, parse, fingerprint, and aggregate a batch of new events. */
export function analyzeEvents(source: SourceContext, events: RawEvent[], opts: IngestOptions) {
  const groups = new Map<string, ErrorGroup>();
  const pii = new Map<SensitiveType, PiiAggregate>();
  let piiEvents = 0;

  for (const e of events) {
    // 1. Detect on the raw text (catches PII in any JSON field), never store it.
    const scan = scanSensitive(e.message, opts.enabledTypes);
    if (source.piiScan && scan.findings.length > 0) {
      piiEvents++;
      for (const f of scan.findings) {
        const agg = pii.get(f.type);
        if (agg) agg.count += f.count;
        else pii.set(f.type, { ...f, stream: e.logStream, eventId: e.eventId });
      }
    }

    // 2. Parse structure from the raw text, then redact the extracted message.
    const parsed = parseLogMessage(e.message);
    if (!parsed.isError) continue;
    const message = parsed.structured ? scanSensitive(parsed.message, opts.enabledTypes).redacted : scan.redacted;
    const service = parsed.service ?? source.serviceName;
    const fp = fingerprintError(service, message);
    const time = new Date(e.timestamp);

    let g = groups.get(fp.fingerprint);
    if (!g) {
      g = { fingerprint: fp.fingerprint, title: fp.title, severity: parsed.severity, service,
            count: 0, first: time, last: time, samples: [] };
      groups.set(fp.fingerprint, g);
    }
    g.count++;
    g.severity = maxSeverity(g.severity, parsed.severity);
    if (time < g.first) g.first = time;
    if (time > g.last) g.last = time;
    if (g.samples.length < opts.maxSamplesPerIncident) {
      g.samples.push({ time, stream: e.logStream, eventId: e.eventId, message: message.slice(0, EXCERPT_CHARS),
                       requestId: parsed.requestId, traceId: parsed.traceId });
    }
  }
  return { groups: [...groups.values()], pii: [...pii.values()], piiEvents };
}

/** DB step: upsert incidents + samples, PII findings, and alerts (inside the caller's transaction). */
export async function persistAnalysis(
  client: PoolClient,
  source: SourceContext,
  analysis: ReturnType<typeof analyzeEvents>,
  opts: IngestOptions,
  totalEvents: number,
): Promise<IngestStats> {
  const stats: IngestStats = {
    events: totalEvents, errors: 0, incidentsTouched: 0, newIncidents: 0, piiEvents: analysis.piiEvents, alertsOpened: 0,
  };

  for (const g of analysis.groups) {
    stats.errors += g.count;
    const { rows } = await client.query<{ id: string; inserted: boolean; prev_status: string | null }>(
      `with prev as (
         select status from public.incidents where organization_id = $1 and fingerprint = $2 for update
       )
       insert into public.incidents (organization_id, fingerprint, title, severity, environment, service_name,
                                     log_source_id, repository_id, first_seen, last_seen, occurrences)
       values ($1, $2, $3, $4, $5, $6, $7,
               (select m.repository_id from public.repository_mappings m
                 where m.organization_id = $1 and (m.log_source_id = $7 or m.service_name = $6) limit 1),
               $8, $9, $10)
       on conflict (organization_id, fingerprint) do update set
         last_seen     = greatest(public.incidents.last_seen, excluded.last_seen),
         occurrences   = public.incidents.occurrences + excluded.occurrences,
         severity      = greatest(public.incidents.severity, excluded.severity),
         repository_id = coalesce(public.incidents.repository_id, excluded.repository_id),
         status        = case when public.incidents.status = 'resolved' then 'new'::public.incident_status
                              else public.incidents.status end
       returning id, (xmax = 0) as inserted, (select status::text from prev) as prev_status`,
      [source.organizationId, g.fingerprint, g.title, g.severity, source.environment, g.service,
       source.id, g.first, g.last, g.count],
    );
    const incident = rows[0]!;
    stats.incidentsTouched++;
    if (incident.inserted) stats.newIncidents++;

    // Keep a bounded number of redacted samples per incident.
    for (const s of g.samples) {
      await client.query(
        `insert into public.incident_events (organization_id, incident_id, log_source_id, event_time, log_stream,
                                             provider_event_id, message_excerpt, request_id, trace_id)
         select $1, $2, $3, $4, $5, $6, $7, $8, $9
          where (select count(*) from public.incident_events where incident_id = $2) < 200`,
        [source.organizationId, incident.id, source.id, s.time, s.stream ?? null, s.eventId, s.message,
         s.requestId ?? null, s.traceId ?? null],
      );
    }

    const where = `${g.service ?? source.sourceName}${source.environment ? ` (${source.environment})` : ""}`;
    const body = `${g.title}\nService: ${where}\nLog group: ${source.sourceName}\nEvents this poll: ${g.count}`;
    if (incident.inserted && severityRank[g.severity] >= severityRank[opts.newIncidentMinSeverity]) {
      if (await raiseAlert(client, {
        organizationId: source.organizationId, kind: "new_incident", severity: g.severity,
        title: `New error in ${where}`, body, dedupKey: `incident:${incident.id}:new`,
        incidentId: incident.id, logSourceId: source.id, occurrences: g.count,
      })) stats.alertsOpened++;
    }
    if (incident.prev_status === "resolved") {
      if (await raiseAlert(client, {
        organizationId: source.organizationId, kind: "incident_regression", severity: maxSeverity(g.severity, "high"),
        title: `Resolved error is happening again in ${where}`, body, dedupKey: `incident:${incident.id}:regression`,
        incidentId: incident.id, logSourceId: source.id, occurrences: g.count,
      })) stats.alertsOpened++;
    }
    if (g.count >= opts.spikeThreshold) {
      if (await raiseAlert(client, {
        organizationId: source.organizationId, kind: "incident_spike", severity: maxSeverity(g.severity, "high"),
        title: `Error spike: ${g.count} events in one poll in ${where}`, body, dedupKey: `incident:${incident.id}:spike`,
        incidentId: incident.id, logSourceId: source.id, occurrences: g.count,
      })) stats.alertsOpened++;
    }
  }

  for (const f of analysis.pii) {
    await client.query(
      `insert into public.pii_findings (organization_id, log_source_id, pii_type, category, severity, occurrences,
                                        masked_sample, sample_log_stream, sample_event_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (log_source_id, pii_type) do update set
         occurrences = public.pii_findings.occurrences + excluded.occurrences,
         last_seen = now(),
         masked_sample = excluded.masked_sample,
         sample_log_stream = excluded.sample_log_stream,
         sample_event_id = excluded.sample_event_id`,
      [source.organizationId, source.id, f.type, f.category, f.severity, f.count, f.maskedSample,
       f.stream ?? null, f.eventId],
    );
    const label = SENSITIVE_LABEL[f.type];
    if (await raiseAlert(client, {
      organizationId: source.organizationId,
      kind: f.category === "secret" ? "secret_detected" : "pii_detected",
      severity: f.severity,
      title: `${label} found in logs of ${source.sourceName}`,
      body: [
        `${f.count} occurrence(s) in the latest poll.`,
        `Masked sample: ${f.maskedSample}`,
        f.stream ? `Log stream: ${f.stream}` : null,
        source.serviceName ? `Service: ${source.serviceName}` : null,
        "Values were redacted before storage. Fix the code that logs this field.",
      ].filter(Boolean).join("\n"),
      dedupKey: `pii:${source.id}:${f.type}`,
      logSourceId: source.id,
      occurrences: f.count,
      details: { piiType: f.type, category: f.category },
    })) stats.alertsOpened++;
  }

  return stats;
}
