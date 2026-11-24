import { NextResponse, type NextRequest } from "next/server";
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { getOwnerPool } from "@/backend/db/pools";
import { loadSettings } from "@/backend/settings/store";
import { awsBaseCredentials, cloudWatchClient } from "@/backend/scheduler/aws";
import { discoverLogGroupsSchema } from "@/backend/validation";
import { jsonError, requireApiUser, validationError } from "@/lib/api";
import { asUser } from "@/lib/db";

export const dynamic = "force-dynamic";

const MAX_GROUPS = 2_000;
const MAX_PAGES = 50;

/**
 * Lists the CloudWatch log groups that exist in an AWS account/region, using the same
 * credentials the scheduler would use, so an admin can pick which ones to add.
 * Each group is flagged when this organization already watches it. Needs logs:DescribeLogGroups.
 */
export async function POST(request: NextRequest) {
  const user = await requireApiUser();
  if (!user) return jsonError(401, "Not authenticated");

  const parsed = discoverLogGroupsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationError(parsed.error);
  const i = parsed.data;

  // RLS-scoped checks: caller is owner/admin of the org, and the AWS account belongs to it.
  const check = await asUser(user.id, async (c) => {
    const allowed = (await c.query<{ ok: boolean }>(
      "select app.has_org_role($1, array['owner','admin']::public.org_role[]) as ok", [i.organizationId])).rows[0]?.ok;
    if (!allowed) return { error: 403 as const };
    if (i.awsAccountId) {
      const found = (await c.query("select 1 from public.aws_accounts where id = $1 and organization_id = $2",
        [i.awsAccountId, i.organizationId])).rowCount;
      if (!found) return { error: 404 as const };
    }
    const existing = (await c.query<{ source_name: string }>(
      `select s.source_name from public.log_sources s
         join public.log_connectors c on c.id = s.connector_id
        where s.organization_id = $1 and c.provider = 'cloudwatch' and c.region = $2
          and c.aws_account_id is not distinct from $3::uuid`,
      [i.organizationId, i.region, i.awsAccountId ?? null])).rows.map((r) => r.source_name);
    return { existing: new Set(existing) };
  });
  if ("error" in check) {
    return check.error === 403
      ? jsonError(403, "Only organization owners and admins can browse log groups")
      : jsonError(404, "AWS account not found");
  }

  const owner = getOwnerPool();
  let roleArn: string | null = null;
  let externalId: string | null = null;
  if (i.awsAccountId) {
    const { rows } = await owner.query<{ role_arn: string | null; external_id: string | null }>(
      `select a.role_arn, sec.external_id from public.aws_accounts a
         left join private.aws_account_secrets sec on sec.aws_account_id = a.id
        where a.id = $1`, [i.awsAccountId]);
    roleArn = rows[0]?.role_arn ?? null;
    externalId = rows[0]?.external_id ?? null;
  }

  const cfg = await loadSettings(owner);
  const client = cloudWatchClient(i.region, roleArn, externalId, awsBaseCredentials(cfg));

  const groups: Array<{ name: string; storedBytes: number | null; retentionDays: number | null; createdAt: number | null; added: boolean }> = [];
  let nextToken: string | undefined;
  let pages = 0;
  try {
    do {
      const res = await client.send(new DescribeLogGroupsCommand({
        logGroupNamePrefix: i.prefix || undefined, nextToken, limit: 50,
      }));
      for (const g of res.logGroups ?? []) {
        if (!g.logGroupName) continue;
        groups.push({
          name: g.logGroupName,
          storedBytes: g.storedBytes ?? null,
          retentionDays: g.retentionInDays ?? null,
          createdAt: g.creationTime ?? null,
          added: check.existing.has(g.logGroupName),
        });
      }
      nextToken = res.nextToken;
      pages++;
    } while (nextToken && groups.length < MAX_GROUPS && pages < MAX_PAGES);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return NextResponse.json({ ok: false, errorName: e.name ?? "Error", error: e.message ?? String(err) }, { status: 502 });
  }

  return NextResponse.json({ ok: true, region: i.region, groups, truncated: !!nextToken });
}
