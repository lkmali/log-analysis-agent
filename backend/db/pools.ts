import { createPool } from "./index";

/**
 * One database, one login (SQL_USER / SQL_PASSWORD in .env), two connection pools:
 *
 *   owner pool  scheduler, AI agents, migrations. Owns the tables, so it bypasses RLS.
 *   app pool    dashboard + API requests. Every transaction runs `set local role sre_app`
 *               (see withUser in ./index), so Row-Level Security applies.
 *
 * Keeping the dashboard on the restricted role means a bug in a page can never read
 * another organization's data or the private schema (secrets, sessions).
 */

type Pool = ReturnType<typeof createPool>;
const g = globalThis as unknown as { sreOwnerPool?: Pool; sreAppPool?: Pool };

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set. Add it to .env (see .env.example).`);
  return v;
}

export function connectionString(): string {
  const user = required("SQL_USER");
  const password = required("SQL_PASSWORD");
  const host = required("SQL_HOST");
  const port = process.env.SQL_PORT?.trim() || "5432";
  const database = required("SQL_DATABASE");
  const ssl = process.env.SQL_SSLMODE?.trim();
  return (
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}` +
    (ssl ? `?sslmode=${encodeURIComponent(ssl)}` : "")
  );
}

/** Owner-role pool (bypasses RLS). Server-side background work only. */
export function getOwnerPool(): Pool {
  g.sreOwnerPool ??= createPool({ connectionString: connectionString(), max: 26, applicationName: "claude-sre-owner" });
  return g.sreOwnerPool;
}

/** Pool for dashboard/API requests; use it through withUser() so RLS applies. */
export function getAppPool(): Pool {
  g.sreAppPool ??= createPool({ connectionString: connectionString(), max: 10, applicationName: "claude-sre-web" });
  return g.sreAppPool;
}

export async function closeOwnerPool() {
  const p = g.sreOwnerPool;
  g.sreOwnerPool = undefined;
  await p?.end();
}
