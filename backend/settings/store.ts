import type { createPool } from "@/backend/db";
import { resolveSettings, type Settings } from "./definitions";

type Pool = ReturnType<typeof createPool>;

const CACHE_MS = 10_000;
let cache: { at: number; value: Settings } | undefined;

/**
 * Loads settings + secret values with the OWNER pool (secrets live in the private schema).
 * Cached for a few seconds so every job tick can call it cheaply; saving on the Settings
 * page calls invalidateSettings() so changes apply on the next run.
 */
export async function loadSettings(ownerPool: Pool, { fresh = false } = {}): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [values, secrets] = await Promise.all([
    ownerPool.query<{ key: string; value: unknown }>("select key, value from public.platform_settings"),
    ownerPool.query<{ key: string; value: string }>("select key, value from private.platform_secrets"),
  ]);
  const value = resolveSettings(
    Object.fromEntries(values.rows.map((r) => [r.key, r.value])),
    Object.fromEntries(secrets.rows.map((r) => [r.key, r.value])),
  );
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateSettings() {
  cache = undefined;
}

/** Owner-pool write used by background code (e.g. saving agent ids after provisioning). */
export async function saveSettingValues(ownerPool: Pool, values: Partial<Record<keyof Settings, unknown>>) {
  for (const [key, value] of Object.entries(values)) {
    await ownerPool.query(
      `insert into public.platform_settings (key, value, updated_at) values ($1, $2, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
  invalidateSettings();
}
