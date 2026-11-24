import type { Severity } from "@/backend/db";

export interface ParsedLog {
  severity: Severity;
  /** true when the line is an error/fatal event that should become an incident. */
  isError: boolean;
  /** Human-readable message (message + stack for JSON logs, raw text otherwise). */
  message: string;
  requestId?: string;
  traceId?: string;
  service?: string;
  structured: boolean;
}

type Json = Record<string, unknown>;

const get = (obj: Json, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Json)[k] : undefined), obj);

const firstString = (obj: Json, paths: string[]): string | undefined => {
  for (const p of paths) {
    const v = get(obj, p);
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
};

function levelToSeverity(level: unknown): Severity | undefined {
  if (typeof level === "number") {
    // pino / bunyan numeric levels
    if (level >= 60) return "critical";
    if (level >= 50) return "high";
    if (level >= 40) return "medium";
    return "low";
  }
  if (typeof level !== "string") return undefined;
  const l = level.toLowerCase();
  if (/^(fatal|crit|critical|panic|emerg|emergency|alert)/.test(l)) return "critical";
  if (/^(err|error|severe)/.test(l)) return "high";
  if (/^(warn|warning)/.test(l)) return "medium";
  return "low";
}

const TEXT_CRITICAL = /\b(FATAL|CRITICAL|PANIC|EMERGENCY)\b|panic:/;
const TEXT_ERROR =
  /\bERROR\b|\bError:|\b[A-Z]\w*(Error|Exception)\b|Traceback \(most recent call last\)|Unhandled(Promise)?Rejection|Task timed out|\blevel=(error|err)\b|\[error\]/;
const TEXT_WARN = /\bWARN(ING)?\b|\blevel=warn(ing)?\b/;

/** Parses a CloudWatch log message (JSON, logfmt-ish, Lambda tab format, or plain text). */
export function parseLogMessage(raw: string): ParsedLog {
  // Strip ANSI color codes (e.g. "\x1b[31mERROR\x1b[0m" from colorized loggers) so level words match.
  // eslint-disable-next-line no-control-regex
  const trimmed = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();

  // Lambda runtime format: "<timestamp>\t<requestId>\t<LEVEL>\t<message>"
  const lambda = /^\S+\t([0-9a-f-]{36})\t([A-Z]+)\t([\s\S]*)$/.exec(trimmed);
  const body = lambda ? lambda[3]!.trim() : trimmed;

  if (body.startsWith("{")) {
    try {
      const obj = JSON.parse(body) as Json;
      const severity =
        levelToSeverity(get(obj, "level") ?? get(obj, "severity") ?? get(obj, "levelname") ??
          get(obj, "log.level") ?? get(obj, "lvl") ?? get(obj, "@l") ?? lambda?.[2]) ??
        (get(obj, "err") || get(obj, "error") || get(obj, "exception") ? "high" : "low");
      const msg = firstString(obj, ["message", "msg", "@m", "error.message", "err.message", "errorMessage"]) ?? body;
      const stack = firstString(obj, ["stack", "err.stack", "error.stack", "exception", "stackTrace", "trace"]);
      return {
        severity,
        isError: severity === "high" || severity === "critical",
        message: stack && !msg.includes(stack) ? `${msg}\n${stack}` : msg,
        requestId: firstString(obj, ["requestId", "request_id", "reqId", "req.id", "awsRequestId", "correlationId"]) ?? lambda?.[1],
        traceId: firstString(obj, ["traceId", "trace_id", "dd.trace_id", "trace.id", "xrayTraceId"]),
        service: firstString(obj, ["service", "service.name", "serviceName", "app", "logger"]),
        structured: true,
      };
    } catch {
      // not JSON; fall through to text parsing
    }
  }

  const severity: Severity =
    levelToSeverity(lambda?.[2]) && lambda?.[2] !== "INFO"
      ? levelToSeverity(lambda?.[2])!
      : TEXT_CRITICAL.test(body) ? "critical"
      : TEXT_ERROR.test(body) ? "high"
      : TEXT_WARN.test(body) ? "medium"
      : "low";

  return {
    severity,
    isError: severity === "high" || severity === "critical",
    message: body,
    requestId: lambda?.[1] ?? /RequestId:\s*([0-9a-f-]{36})/i.exec(body)?.[1],
    traceId: /Root=(1-[0-9a-f]{8}-[0-9a-f]{24})/.exec(body)?.[1],
    structured: false,
  };
}
