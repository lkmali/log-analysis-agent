import "server-only";

import { withUser } from "@/backend/db";
import type { PoolClient } from "@/backend/db";
import { getAppPool } from "@/backend/db/pools";

export { getAppPool as getPool };

/** Runs queries as the given user so RLS scopes every row to their organizations. */
export function asUser<T>(userId: string | null, fn: (client: PoolClient) => Promise<T>) {
  return withUser(getAppPool(), userId, fn);
}
