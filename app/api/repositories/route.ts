import { NextResponse, type NextRequest } from "next/server";
import { registerRepositorySchema } from "@/backend/validation";
import { databaseError, jsonError, requireApiUser, validationError } from "@/lib/api";
import { asUser } from "@/lib/db";

/** Register a repository (role-checked + audited in app.register_repository). */
export async function POST(request: NextRequest) {
  const user = await requireApiUser();
  if (!user) return jsonError(401, "Not authenticated");

  const parsed = registerRepositorySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationError(parsed.error);
  const i = parsed.data;

  // Phase 5/6: verify GitHub App installation access to owner/name before saving.
  try {
    const id = await asUser(user.id, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "select app.register_repository($1, $2, $3, $4, $5, $6, $7, $8, $9) as id",
        [i.organizationId, i.owner, i.name, i.defaultBranch, i.installationId ?? null,
         i.technology, i.services, i.testCommands, i.prPolicy],
      );
      return rows[0]!.id;
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    return databaseError(err);
  }
}
