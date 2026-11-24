import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { updateAlertSchema } from "@/backend/validation";
import { databaseError, jsonError, requireApiUser, validationError } from "@/lib/api";
import { asUser } from "@/lib/db";

/** Acknowledge / resolve / reopen an alert. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (!user) return jsonError(401, "Not authenticated");
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return jsonError(400, "Invalid id");

  const parsed = updateAlertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationError(parsed.error);

  try {
    await asUser(user.id, (c) => c.query("select app.set_alert_status($1, $2)", [id, parsed.data.status]));
    return NextResponse.json({ id, status: parsed.data.status });
  } catch (err) {
    return databaseError(err);
  }
}
