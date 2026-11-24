import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { toggleSchema } from "@/backend/validation";
import { databaseError, jsonError, requireApiUser, validationError } from "@/lib/api";
import { asUser } from "@/lib/db";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (!user) return jsonError(401, "Not authenticated");
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return jsonError(400, "Invalid id");

  const parsed = toggleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationError(parsed.error);

  try {
    await asUser(user.id, (c) => c.query("select app.set_repository_enabled($1, $2)", [id, parsed.data.enabled]));
    return NextResponse.json({ id, enabled: parsed.data.enabled });
  } catch (err) {
    return databaseError(err);
  }
}
