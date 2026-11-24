import { NextResponse, type NextRequest } from "next/server";
import { addCloudWatchSourceSchema } from "@/backend/validation";
import { databaseError, jsonError, requireApiUser, validationError } from "@/lib/api";
import { asUser } from "@/lib/db";

/**
 * Add one or more CloudWatch log groups for the EC2 scheduler to poll. The scheduler picks
 * them up on its next tick; no AWS infrastructure is provisioned by this call.
 * Several groups (`logGroups`) are added in one transaction with the same settings;
 * groups this organization already watches with the same region/credentials are skipped.
 */
export async function POST(request: NextRequest) {
  const user = await requireApiUser();
  if (!user) return jsonError(401, "Not authenticated");

  const parsed = addCloudWatchSourceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationError(parsed.error);
  const i = parsed.data;
  const groups = [...new Set([...(i.logGroups ?? []), ...(i.logGroup ? [i.logGroup] : [])])];

  try {
    const result = await asUser(user.id, async (c) => {
      // RLS-scoped: only this org's sources are visible.
      const existing = new Set((await c.query<{ source_name: string }>(
        `select s.source_name from public.log_sources s
           join public.log_connectors c on c.id = s.connector_id
          where s.organization_id = $1 and c.provider = 'cloudwatch' and c.region = $2
            and c.aws_account_id is not distinct from $3::uuid and s.source_name = any($4::text[])`,
        [i.organizationId, i.region, i.awsAccountId ?? null, groups],
      )).rows.map((r) => r.source_name));

      const ids: string[] = [];
      for (const g of groups) {
        if (existing.has(g)) continue;
        const { rows } = await c.query<{ id: string }>(
          "select app.add_cloudwatch_source($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as id",
          [i.organizationId, i.region, g, i.serviceName, i.environment, i.ingestMode,
           i.filterPattern, i.piiScan, i.pollIntervalSeconds, i.awsAccountId ?? null],
        );
        ids.push(rows[0]!.id);
      }
      return { ids, skipped: [...existing] };
    });
    if (groups.length === 1 && result.skipped.length === 1) return jsonError(409, "This log group is already added");
    return NextResponse.json({ id: result.ids[0], ids: result.ids, skipped: result.skipped }, { status: 201 });
  } catch (err) {
    return databaseError(err);
  }
}
