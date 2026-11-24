/**
 * One-time helper: copies settings from an env-style file into the database.
 *   npm run settings:import                 (reads .env.settings-import)
 *   npm run settings:import -- other.env
 * Only known settings with non-empty values are imported; anything already saved is overwritten.
 */
import { readFile } from "node:fs/promises";
import { closeOwnerPool, getOwnerPool } from "@/backend/db/pools";
import { SETTINGS, valueSchema, type SettingDef } from "./definitions";

async function main() {
  const file = process.argv[2] ?? ".env.settings-import";
  const text = await readFile(file, "utf8");
  const pool = getOwnerPool();
  const defs = new Map((SETTINGS as readonly SettingDef[]).map((d) => [d.key, d]));
  let imported = 0;

  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, rawValue] = m as unknown as [string, string, string];
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
    const def = defs.get(key);
    if (!def || value === "") continue;

    const parsed = valueSchema(def).safeParse(value);
    if (!parsed.success) {
      console.warn(`skipped ${key}: ${parsed.error.issues[0]?.message}`);
      continue;
    }
    if (def.type === "secret") {
      await pool.query(
        `insert into private.platform_secrets (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, parsed.data],
      );
    } else {
      await pool.query(
        `insert into public.platform_settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(parsed.data)],
      );
    }
    console.log(`imported ${key}${def.type === "secret" ? " (secret)" : ""}`);
    imported++;
  }
  console.log(`${imported} setting(s) imported from ${file}`);
  await closeOwnerPool();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeOwnerPool().catch(() => {});
  process.exit(1);
});
