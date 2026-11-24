import { NextResponse, type NextRequest } from "next/server";
import { DescribeLogStreamsCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { z } from "zod";
import { getOwnerPool } from "@/backend/db/pools";
import { loadSettings } from "@/backend/settings/store";
import { awsBaseCredentials, cloudWatchClient } from "@/backend/scheduler/aws";
import { DEFAULT_ERROR_PATTERN } from "@/backend/scheduler/jobs/cloudwatch-poll";
import { DEFAULT_ENABLED_TYPES, scanSensitive } from "@/backend/scheduler/pipeline/pii";
import { jsonError, requireApiUser } from "@/lib/api";
import { asUser } from "@/lib/db";

export const dynamic = "force-dynamic";

const LOOKBACK_MINUTES = 15;

/**
 * Live connectivity check: reads the log group directly from CloudWatch with the
 * scheduler's credentials. Returns how many lines exist in the last 15 minutes
 * (all lines, and lines matching this source's filter), the newest stream, and a
 * few sample lines. Samples are redacted; nothing is stored.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (!user) return jsonError(401, "Not authenticated");
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return jsonError(400, "Invalid id");

  // RLS: only members of the source's organization get a row back.
  const visible = await asUser(user.id, async (c) =>
    (await c.query("select 1 from public.log_sources where id = $1", [id])).rowCount);
  if (!visible) return jsonError(404, "Log source not found");

  const owner = getOwnerPool();
  const { rows } = await owner.query<{
    source_name: string; region: string | null; ingest_mode: string; filter_pattern: string | null;
    role_arn: string | null; external_id: string | null;
  }>(
    `select s.source_name, c.region, s.ingest_mode, s.filter_pattern, a.role_arn, sec.external_id
       from public.log_sources s
       join public.log_connectors c on c.id = s.connector_id
       left join public.aws_accounts a on a.id = c.aws_account_id
       left join private.aws_account_secrets sec on sec.aws_account_id = a.id
      where s.id = $1`, [id]);
  const src = rows[0];
  if (!src?.region) return jsonError(400, "Log source has no region");

  const cfg = await loadSettings(owner);
  const client = cloudWatchClient(src.region, src.role_arn, src.external_id, awsBaseCredentials(cfg));
  const endTime = Date.now();
  const startTime = endTime - LOOKBACK_MINUTES * 60_000;
  const filterPattern = src.filter_pattern ?? (src.ingest_mode === "errors_only" ? DEFAULT_ERROR_PATTERN : undefined);

  try {
    const [streams, all, matching] = await Promise.all([
      client.send(new DescribeLogStreamsCommand({
        logGroupName: src.source_name, orderBy: "LastEventTime", descending: true, limit: 1,
      })).catch((e) => ({ error: (e as Error).message })),
      client.send(new FilterLogEventsCommand({ logGroupName: src.source_name, startTime, endTime, limit: 50 })),
      filterPattern
        ? client.send(new FilterLogEventsCommand({ logGroupName: src.source_name, startTime, endTime, filterPattern, limit: 50 }))
        : null,
    ]);

    const latestStream = "logStreams" in streams ? streams.logStreams?.[0] : undefined;
    const allEvents = all.events ?? [];
    const matchEvents = matching ? matching.events ?? [] : allEvents;
    return NextResponse.json({
      ok: true,
      logGroup: src.source_name,
      region: src.region,
      lookbackMinutes: LOOKBACK_MINUTES,
      linesInWindow: allEvents.length,
      linesInWindowCapped: !!all.nextToken,          // true = 50+ lines
      matchingFilter: matchEvents.length,
      matchingFilterCapped: matching ? !!matching.nextToken : !!all.nextToken,
      filterPattern: filterPattern ?? null,
      latestStream: latestStream
        ? { name: latestStream.logStreamName, lastEventAt: latestStream.lastEventTimestamp ?? null }
        : null,
      latestStreamError: "error" in streams ? streams.error : null,
      samples: allEvents.slice(-5).reverse().map((e) => ({
        time: e.timestamp ?? null,
        message: scanSensitive(e.message ?? "", DEFAULT_ENABLED_TYPES).redacted.slice(0, 300),
      })),
    });
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return NextResponse.json({ ok: false, errorName: e.name ?? "Error", error: e.message ?? String(err) });
  }
}
