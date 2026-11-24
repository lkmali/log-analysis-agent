import { FilterLogEventsCommand, type CloudWatchLogsClient, type FilteredLogEvent } from "@aws-sdk/client-cloudwatch-logs";
import { withTransaction, type IngestMode } from "@/backend/db";
import { awsBaseCredentials, cloudWatchClient } from "../aws";
import { raiseAlert, resolveAlerts } from "../alerts";
import type { Config } from "../config";
import { errorMessage } from "../logger";
import { analyzeEvents, persistAnalysis, type IngestOptions, type RawEvent, type SourceContext } from "../pipeline/ingest";
import { DEFAULT_ENABLED_TYPES, type SensitiveType } from "../pipeline/pii";
import type { JobContext } from "../runner";

/** Default pattern for "errors only" mode (CloudWatch terms are case-sensitive; ? = OR). */
export const DEFAULT_ERROR_PATTERN =
  '?ERROR ?Error ?error ?FATAL ?Fatal ?fatal ?CRITICAL ?Exception ?exception ?Traceback ?panic ?"Task timed out"';

interface DueSource {
  id: string;
  organization_id: string;
  source_name: string;
  service_name: string | null;
  environment: string | null;
  ingest_mode: IngestMode;
  filter_pattern: string | null;
  pii_scan: boolean;
  connector_id: string;
  region: string;
  role_arn: string | null;
  external_id: string | null;
  window_start: Date | null;
  window_end: Date | null;
  next_token: string | null;
}

/** Errors that mean "configuration/permissions are wrong" — alert immediately. */
const CONFIG_ERRORS = new Set([
  "AccessDeniedException", "UnrecognizedClientException", "ResourceNotFoundException",
  "InvalidParameterException", "ExpiredTokenException", "CredentialsProviderError",
  "AccessDenied", "InvalidClientTokenId",
]);

function ingestOptionsFor(cfg: Config): IngestOptions {
  return {
    enabledTypes: cfg.piiTypes ? new Set(cfg.piiTypes as SensitiveType[]) : DEFAULT_ENABLED_TYPES,
    maxSamplesPerIncident: cfg.CW_MAX_SAMPLES_PER_INCIDENT,
    newIncidentMinSeverity: cfg.NEW_INCIDENT_ALERT_MIN_SEVERITY,
    spikeThreshold: cfg.SPIKE_THRESHOLD,
  };
}

export function cloudWatchPollJob() {
  return async function run({ pool, log, cfg }: JobContext) {
    const ingestOpts = ingestOptionsFor(cfg);
    const { rows: sources } = await pool.query<DueSource>(
      `select s.id, s.organization_id, s.source_name, s.service_name, s.environment, s.ingest_mode,
              s.filter_pattern, s.pii_scan, c.id as connector_id, c.region, a.role_arn, sec.external_id,
              cp.window_start, cp.window_end, cp.next_token
         from public.log_sources s
         join public.log_connectors c on c.id = s.connector_id
         left join public.aws_accounts a on a.id = c.aws_account_id
         left join private.aws_account_secrets sec on sec.aws_account_id = a.id
         left join private.cloudwatch_checkpoints cp on cp.log_source_id = s.id
        where c.provider = 'cloudwatch' and c.region is not null and s.enabled and c.status <> 'disabled'
          and (s.last_polled_at is null
               or s.last_polled_at + make_interval(secs => s.poll_interval_seconds) <= now())
        order by s.last_polled_at nulls first
        limit $1`,
      [cfg.CW_SOURCES_PER_TICK],
    );

    const totals = { sources: sources.length, failed: 0, fetched: 0, pages: 0, events: 0, errors: 0, newIncidents: 0, piiEvents: 0, alertsOpened: 0 };
    let next = 0;
    const worker = async () => {
      while (next < sources.length) {
        const source = sources[next++]!;
        const slog = log.child({ logSourceId: source.id, logGroup: source.source_name });
        try {
          const s = await pollSource(source);
          totals.fetched += s.fetched;
          totals.pages += s.pages;
          totals.events += s.events;
          totals.errors += s.errors;
          totals.newIncidents += s.newIncidents;
          totals.piiEvents += s.piiEvents;
          totals.alertsOpened += s.alertsOpened;
          slog.info("polled", { ...s, skipped: s.events - s.errors });
        } catch (err) {
          totals.failed++;
          await recordSourceFailure(source, err).catch((e) => slog.error("failed to record source failure", { error: errorMessage(e) }));
          slog.warn("poll failed", { error: errorMessage(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(cfg.CW_CONCURRENCY, sources.length) }, worker));
    return totals;

    // -----------------------------------------------------------------------
    async function pollSource(source: DueSource) {
      const client = cloudWatchClient(source.region, source.role_arn, source.external_id, awsBaseCredentials(cfg));
      const now = Date.now();
      let windowStart: number;
      let windowEnd: number;
      let token: string | undefined;

      if (source.next_token && source.window_start && source.window_end) {
        // Resume a window that was cut short by the per-run event/time budget.
        windowStart = source.window_start.getTime();
        windowEnd = source.window_end.getTime();
        token = source.next_token;
      } else {
        windowStart = source.window_end
          ? source.window_end.getTime() - cfg.CW_OVERLAP_SECONDS * 1000
          : now - cfg.CW_INITIAL_LOOKBACK_MINUTES * 60_000;
        windowEnd = now - cfg.CW_LAG_SECONDS * 1000;
      }

      const ctx: SourceContext = {
        id: source.id, organizationId: source.organization_id, sourceName: source.source_name,
        serviceName: source.service_name, environment: source.environment, piiScan: source.pii_scan,
      };
      const filterPattern = source.filter_pattern ?? (source.ingest_mode === "errors_only" ? DEFAULT_ERROR_PATTERN : undefined);
      const stats = { fetched: 0, events: 0, errors: 0, newIncidents: 0, piiEvents: 0, alertsOpened: 0, pages: 0 };
      let lastEventAt: number | null = null;
      const started = Date.now();

      if (windowEnd > windowStart) {
        do {
          const page = await fetchPage(client, source.source_name, windowStart, windowEnd, filterPattern, token);
          stats.pages++;
          token = page.nextToken;
          const events = (page.events ?? []).filter((e): e is FilteredLogEvent & { eventId: string } => !!e.eventId);
          stats.fetched += events.length;
          if (events.length > 0) {
            const s = await ingestPage(ctx, events);
            stats.events += s.events;
            stats.errors += s.errors;
            stats.newIncidents += s.newIncidents;
            stats.piiEvents += s.piiEvents;
            stats.alertsOpened += s.alertsOpened;
            for (const e of events) if (e.timestamp && (!lastEventAt || e.timestamp > lastEventAt)) lastEventAt = e.timestamp;
          }
        } while (
          token &&
          stats.events < cfg.CW_MAX_EVENTS_PER_SOURCE_RUN &&
          Date.now() - started < cfg.CW_SOURCE_TIME_BUDGET_SECONDS * 1000
        );
      }

      await withTransaction(pool, async (c) => {
        if (windowEnd > windowStart) {
          await c.query(
            `insert into private.cloudwatch_checkpoints (log_source_id, window_start, window_end, next_token, updated_at)
             values ($1, $2, $3, $4, now())
             on conflict (log_source_id) do update set window_start = excluded.window_start,
               window_end = excluded.window_end, next_token = excluded.next_token, updated_at = now()`,
            [source.id, new Date(windowStart), new Date(windowEnd), token ?? null],
          );
        }
        await c.query(
          `update public.log_sources set last_polled_at = now(), last_error = null,
                  last_event_at = greatest(last_event_at, $2),
                  polls_total = polls_total + 1,
                  events_fetched_total = events_fetched_total + $3,
                  events_new_total = events_new_total + $4,
                  errors_detected_total = errors_detected_total + $5,
                  last_poll_fetched = $3, last_poll_new = $4, last_poll_errors = $5, last_poll_pages = $6,
                  last_poll_window_start = $7, last_poll_window_end = $8
            where id = $1`,
          [source.id, lastEventAt ? new Date(lastEventAt) : null, stats.fetched, stats.events, stats.errors,
           stats.pages, new Date(windowStart), new Date(Math.max(windowStart, windowEnd))],
        );
        await c.query(
          `update public.log_connectors set status = 'connected', last_success_at = now(), last_error = null
            where id = $1 and status <> 'disabled'`,
          [source.connector_id],
        );
        await resolveAlerts(c, source.organization_id, `connector:${source.id}`);
      });
      return stats;
    }

    async function ingestPage(ctx: SourceContext, events: (FilteredLogEvent & { eventId: string })[]) {
      return withTransaction(pool, async (c) => {
        // Dedupe: only events never processed before (overlap window, resumed tokens).
        const { rows } = await c.query<{ event_id: string }>(
          `insert into private.processed_log_events (log_source_id, event_id)
           select $1, unnest($2::text[]) on conflict do nothing returning event_id`,
          [ctx.id, events.map((e) => e.eventId)],
        );
        const fresh = new Set(rows.map((r) => r.event_id));
        const raw: RawEvent[] = events
          .filter((e) => fresh.has(e.eventId))
          .map((e) => ({ eventId: e.eventId, timestamp: e.timestamp ?? Date.now(), logStream: e.logStreamName, message: e.message ?? "" }));
        if (raw.length === 0) return { events: 0, errors: 0, newIncidents: 0, piiEvents: 0, alertsOpened: 0 };
        return persistAnalysis(c, ctx, analyzeEvents(ctx, raw, ingestOpts), ingestOpts, raw.length);
      });
    }

    async function recordSourceFailure(source: DueSource, err: unknown) {
      const name = (err as { name?: string })?.name ?? "Error";
      const message = errorMessage(err).slice(0, 500);
      const throttled = name === "ThrottlingException" || name === "LimitExceededException";
      await withTransaction(pool, async (c) => {
        await c.query("update public.log_sources set last_polled_at = now(), last_error = $2 where id = $1", [source.id, message]);
        await c.query(
          "update public.log_connectors set status = 'degraded', last_error = $2 where id = $1 and status <> 'disabled'",
          [source.connector_id, message],
        );
        await c.query(
          `insert into public.connector_health_checks (organization_id, connector_id, log_source_id, status, error_code, message)
           values ($1, $2, $3, 'degraded', $4, $5)`,
          [source.organization_id, source.connector_id, source.id, name, message],
        );
        if (!throttled) {
          await raiseAlert(c, {
            organizationId: source.organization_id,
            kind: "connector_error",
            severity: CONFIG_ERRORS.has(name) ? "high" : "medium",
            title: `Cannot read CloudWatch log group ${source.source_name}`,
            body: `${message}\nRegion: ${source.region}\n${
              CONFIG_ERRORS.has(name)
                ? "Check the scheduler IAM role has logs:FilterLogEvents on this log group (or sts:AssumeRole for the cross-account role) and that the log group exists."
                : "The scheduler will retry on the next poll."}`,
            dedupKey: `connector:${source.id}`,
            logSourceId: source.id,
            details: { errorName: name, region: source.region },
          });
        }
      });
    }
  };
}

async function fetchPage(
  client: CloudWatchLogsClient,
  logGroupName: string,
  startTime: number,
  endTime: number,
  filterPattern: string | undefined,
  nextToken: string | undefined,
) {
  return client.send(
    new FilterLogEventsCommand({ logGroupName, startTime, endTime, filterPattern, nextToken, limit: 1000 }),
  );
}
