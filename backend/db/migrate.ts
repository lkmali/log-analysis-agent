/**
 * Minimal forward-only migration runner.
 *   npm run db:migrate        (connects as the owner role from the SQL_* settings in .env)
 * Applies db/migrations/*.sql in filename order, each in its own transaction,
 * and records them in public.schema_migrations.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, withTransaction } from "./index";
import { connectionString } from "./pools";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = process.env.MIGRATIONS_DIR ?? path.resolve(here, "../../db/migrations");

async function main() {
  const pool = createPool({ connectionString: connectionString(), max: 1, applicationName: "claude-sre-migrate" });

  try {
    await pool.query(`create table if not exists public.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
    const applied = new Set(
      (await pool.query<{ version: string }>("select version from public.schema_migrations")).rows.map((r) => r.version),
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql") && !f.startsWith("0000_")).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await withTransaction(pool, async (client) => {
        await client.query(sql);
        await client.query("insert into public.schema_migrations (version) values ($1)", [file]);
      });
      console.log(`applied ${file}`);
      count++;
    }
    console.log(count === 0 ? "database is up to date" : `applied ${count} migration(s)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
