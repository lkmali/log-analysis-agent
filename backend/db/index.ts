import pg from "pg";

export * from "./types";
export * from "./errors";
export type { PoolClient, QueryResultRow } from "pg";

// Return bigint (int8) columns as JS numbers. Counts in this app stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
}

export function createPool({ connectionString, max = 10, applicationName = "claude-sre" }: PoolOptions) {
  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: applicationName,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  pool.on("error", (err) => {
    // Idle client errors (e.g. server restart) must not crash the process.
    console.error(JSON.stringify({ level: "error", msg: "pg pool error", error: err.message }));
  });
  return pool;
}

/** Runs fn inside a transaction. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs fn inside a transaction acting as `userId`. The transaction switches to the
 * restricted `sre_app` role and Row-Level Security policies read `app.user_id`,
 * so the dashboard only ever sees that user's organizations.
 * Pass null for unauthenticated calls (e.g. login), which see no tenant rows.
 */
export async function withUser<T>(
  pool: pg.Pool,
  userId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    // `local`: reverts at commit/rollback, so pooled connections return to the owner role.
    await client.query("set local role sre_app");
    await client.query("select set_config('app.user_id', $1, true)", [userId ?? ""]);
    return fn(client);
  });
}
