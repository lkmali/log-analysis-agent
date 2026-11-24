import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { toggleSchema, updateLogSourceSchema } from "@/backend/validation";
import { databaseError, jsonError, requireApiUser, validationError } from "@/lib/api";
import { asUser } from "@/lib/db";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (!user) return jsonError(401, "Not authenticated");
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return jsonError(400, "Invalid id");

  const json = await request.json().catch(() => null);

  // Full edit (Edit form) when more than `enabled` is sent; otherwise the Enable/Disable toggle.
  if (json && typeof json === "object" && "ingestMode" in json) {
    const full = updateLogSourceSchema.safeParse(json);
    if (!full.success) return validationError(full.error);
    const u = full.data;
    try {
      await asUser(user.id, (c) => c.query(
        "select app.update_log_source($1, $2, $3, $4, $5, $6, $7, $8)",
        [id, u.serviceName, u.environment, u.ingestMode, u.filterPattern, u.piiScan, u.pollIntervalSeconds, u.enabled],
      ));
      return NextResponse.json({ id, ...u });
    } catch (err) {
      return databaseError(err);
    }
  }

  const parsed = toggleSchema.safeParse(json);
  if (!parsed.success) return validationError(parsed.error);

  try {
    await asUser(user.id, (c) => c.query("select app.set_log_source_enabled($1, $2)", [id, parsed.data.enabled]));
    return NextResponse.json({ id, enabled: parsed.data.enabled });
  } catch (err) {
    return databaseError(err);
  }
}
