import { createHash } from "node:crypto";

const LEADING_NOISE = [
  /^\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+(Z|[+-]\d{2}:?\d{2})?\]?\s*/, // ISO timestamps
  /^\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\]?:?\s*/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*/i,
];

/** Replaces variable parts so the same error with different IDs groups together. */
export function normalizeErrorText(line: string): string {
  let s = line.trim();
  for (let i = 0; i < 3; i++) for (const re of LEADING_NOISE) s = s.replace(re, "");
  return s
    .replace(/\[REDACTED:[A-Z_]+\]/g, "<redacted>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\bhttps?:\/\/\S+/g, "<url>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(:\d+)?\b/g, "<ip>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    // Keep short identifier-like quoted strings (e.g. reading 'patientId'); drop the rest.
    .replace(/(["'`])(.*?)\1/g, (m, _q, inner: string) => (/^[A-Za-z_$][\w$.-]{0,63}$/.test(inner) ? m : "<str>"))
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

/** First application stack frame without line/column numbers (Node.js, Python, Java). */
export function topFrame(message: string): string | undefined {
  for (const line of message.split("\n").slice(1, 40)) {
    const node = /^\s*at\s+(?:(.+?)\s+\()?(.+?):\d+:\d+\)?\s*$/.exec(line);
    if (node && !node[2]!.includes("node_modules") && !node[2]!.startsWith("node:")) {
      return `${node[1] ?? "<anonymous>"} ${node[2]!.replace(/^.*\/(src|app|dist)\//, "$1/")}`;
    }
    const py = /^\s*File "(.+?)", line \d+, in (\S+)/.exec(line);
    if (py && !py[1]!.includes("site-packages")) return `${py[2]} ${py[1]!.replace(/^.*\/(src|app)\//, "$1/")}`;
    const java = /^\s*at\s+([\w$.]+)\(([\w$.]+):\d+\)/.exec(line);
    if (java && !/^(java|javax|sun|org\.springframework)\./.test(java[1]!)) return `${java[1]} ${java[2]}`;
  }
  return undefined;
}

export interface Fingerprint {
  fingerprint: string;
  title: string;
}

/**
 * Stable grouping key for an error: service + normalized first line + top frame.
 * `message` must already be redacted.
 */
export function fingerprintError(service: string | null | undefined, message: string): Fingerprint {
  const firstLine = message.split("\n").find((l) => l.trim()) ?? message;
  const head = normalizeErrorText(firstLine);
  const frame = topFrame(message) ?? "";
  const fingerprint = createHash("sha256").update(`${service ?? ""}|${head}|${frame}`).digest("hex").slice(0, 32);

  let title = firstLine.trim();
  for (const re of LEADING_NOISE) title = title.replace(re, "");
  title = title.replace(/\s+/g, " ").slice(0, 200) || "Unknown error";
  return { fingerprint, title };
}
