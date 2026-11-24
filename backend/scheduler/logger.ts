type Level = "debug" | "info" | "warn" | "error";
const rank: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON logs to stdout (collected by journald on EC2). Never log raw log lines. */
/** minLevel may be a function so the level can follow the Settings page without a restart. */
export function createLogger(minLevel: Level | (() => Level) = "info", base: Record<string, unknown> = {}): Logger {
  const current = typeof minLevel === "function" ? minLevel : () => minLevel;
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (rank[level] < rank[current()]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...base, ...fields });
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
    info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
    warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
    error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
    child: (f: Record<string, unknown>) => createLogger(minLevel, { ...base, ...f }),
  };
}
export interface Logger {
  debug(msg: string, f?: Record<string, unknown>): void;
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
  child(f: Record<string, unknown>): Logger;
}

export const errorMessage = (err: unknown) =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 1000);
