import "server-only";

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { asUser } from "./db";

export const SESSION_COOKIE = "sre_session";
const BCRYPT_ROUNDS = 12;
// Used when the email doesn't exist so response time doesn't reveal valid accounts.
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEeO5Z0Y5Yy8bqv5Ue1f3q0p3Jt0M3l6mGa";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  /** Platform-level admin: can change platform settings. */
  isSuperadmin: boolean;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ttlSeconds = () => Number(process.env.SESSION_TTL_SECONDS ?? 604800);

export function hashPassword(password: string) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** Returns the user id when the email/password pair is valid. */
export async function verifyCredentials(email: string, password: string): Promise<string | null> {
  const row = await asUser(null, async (c) => {
    const { rows } = await c.query<{ user_id: string; password_hash: string }>(
      "select user_id, password_hash from app.get_login($1)",
      [email],
    );
    return rows[0];
  });
  const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
  return ok && row ? row.user_id : null;
}

/** Creates a DB session and sets the httpOnly cookie. Only the token's hash is stored. */
export async function startSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = await asUser(null, async (c) => {
    const { rows } = await c.query<{ expires: Date }>(
      "select app.create_session($1, $2, $3) as expires",
      [userId, sha256(token), ttlSeconds()],
    );
    return rows[0]!.expires;
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return asUser(null, async (c) => {
    const { rows } = await c.query<{ user_id: string; email: string; display_name: string | null; is_superadmin: boolean }>(
      "select user_id, email, display_name, is_superadmin from app.session_user($1)",
      [sha256(token)],
    );
    const r = rows[0];
    return r ? { id: r.user_id, email: r.email, displayName: r.display_name, isSuperadmin: r.is_superadmin } : null;
  });
}

export async function endSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await asUser(null, (c) => c.query("select app.delete_session($1)", [sha256(token)]));
  }
  store.delete(SESSION_COOKIE);
}
