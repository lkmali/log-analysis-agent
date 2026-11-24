import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { createPool } from "@/backend/db";
import type { Severity } from "@/backend/db";
import { loadSettings } from "@/backend/settings/store";
import { awsBaseCredentials, cloudWatchClient } from "@/backend/scheduler/aws";
import { parseLogMessage } from "@/backend/scheduler/pipeline/normalize";
import { redact } from "@/backend/scheduler/pipeline/pii";

type Pool = ReturnType<typeof createPool>;

/** Level filter shown in the Logs page. Mapped from the parser's severity. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_OF: Record<Severity, LogLevel> = { critical: "fatal", high: "error", medium: "warn", low: "info" };

export const TIME_RANGES = { "15m": 15, "1h": 60, "6h": 360, "24h": 1440, "3d": 4320, "7d": 10080 } as const;
export type TimeRange = keyof typeof TIME_RANGES;

export interface LogSearch {
  sourceIds: string[];
  levels: LogLevel[];
  range: TimeRange;
  /** Free text: sent to CloudWatch as a quoted term (exact, case-sensitive match). */
  text: string;
  /** Max lines returned overall. */
  limit: number;
}

export interface LogLine {
  time: number;
  sourceId: string;
  logGroup: string;
  service: string | null;
  stream: string | null;
  level: LogLevel;
  message: string;
  requestId?: string;
  traceId?: string;
}

export interface LogSearchResult {
  lines: LogLine[];
  /** Per-source fetch outcome (errors are shown, not thrown). */
  sources: Array<{ id: string; logGroup: string; scanned: number; matched: number; truncated: boolean; error?: string }>;
}

const MAX_SCAN_PER_SOURCE = 2_000;
const MAX_PAGES_PER_SOURCE = 10;
const MAX_MESSAGE_CHARS = 4_000;

/**
 * Live search across several CloudWatch log groups. Reads with the scheduler's AWS credentials
 * (owner pool, because cross-account role secrets live in the private schema), parses each line
 * to a level, keeps the selected levels, redacts PII/secrets, and merges newest first.
 * Nothing is stored. The caller must already have checked the source ids belong to the user's org.
 */
export async function searchLogs(owner: Pool, q: LogSearch): Promise<LogSearchResult> {
  if (!q.sourceIds.length) return { lines: [], sources: [] };
  const { rows } = await owner.query<{
    id: string; source_name: string; service_name: string | null; region: string | null;
    role_arn: string | null; external_id: string | null;
  }>(
    `select s.id, s.source_name, s.service_name, c.region, a.role_arn, sec.external_id
       from public.log_sources s
       join public.log_connectors c on c.id = s.connector_id and c.provider = 'cloudwatch'
       left join public.aws_accounts a on a.id = c.aws_account_id
       left join private.aws_account_secrets sec on sec.aws_account_id = a.id
      where s.id = any($1::uuid[])`,
    [q.sourceIds],
  );
  const cfg = await loadSettings(owner);
  const base = awsBaseCredentials(cfg);
  const endTime = Date.now();
  const startTime = endTime - TIME_RANGES[q.range] * 60_000;
  const levels = new Set(q.levels.length ? q.levels : LOG_LEVELS);
  const text = q.text.replace(/"/g, "").trim();
  const filterPattern = text ? `"${text}"` : undefined;

  const perSource = await Promise.all(rows.map(async (src) => {
    const summary = { id: src.id, logGroup: src.source_name, scanned: 0, matched: 0, truncated: false } as LogSearchResult["sources"][number];
    const lines: LogLine[] = [];
    if (!src.region) return { summary: { ...summary, error: "no region" }, lines };
    const cw = cloudWatchClient(src.region, src.role_arn, src.external_id, base);
    let nextToken: string | undefined;
    let pages = 0;
    try {
      // CloudWatch returns oldest first; read the window and keep the newest matches.
      do {
        const res = await cw.send(new FilterLogEventsCommand({
          logGroupName: src.source_name, startTime, endTime, filterPattern, nextToken,
          limit: Math.min(1_000, MAX_SCAN_PER_SOURCE - summary.scanned),
        }));
        for (const e of res.events ?? []) {
          summary.scanned++;
          const parsed = parseLogMessage(e.message ?? "");
          const level = LEVEL_OF[parsed.severity];
          if (!levels.has(level)) continue;
          summary.matched++;
          lines.push({
            time: e.timestamp ?? 0,
            sourceId: src.id,
            logGroup: src.source_name,
            service: parsed.service ?? src.service_name,
            stream: e.logStreamName ?? null,
            level,
            message: redact(parsed.message).slice(0, MAX_MESSAGE_CHARS),
            requestId: parsed.requestId,
            traceId: parsed.traceId,
          });
        }
        nextToken = res.nextToken;
        pages++;
      } while (nextToken && summary.scanned < MAX_SCAN_PER_SOURCE && pages < MAX_PAGES_PER_SOURCE);
      summary.truncated = !!nextToken;
    } catch (err) {
      summary.error = (err as Error).message ?? String(err);
    }
    return { summary, lines };
  }));

  const lines = perSource.flatMap((p) => p.lines).sort((a, b) => b.time - a.time).slice(0, q.limit);
  return { lines, sources: perSource.map((p) => p.summary) };
}
