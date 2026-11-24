/**
 * PII and secret detection + redaction for log lines.
 *
 * - Detection runs on the raw log text; nothing raw is ever persisted.
 * - Redaction replaces each match with `[REDACTED:<TYPE>]` (no digits, so later
 *   detectors cannot re-match a placeholder).
 * - Detectors run in order: secrets first, then structured IDs with checksums
 *   (cards, Aadhaar), then looser patterns (phone), so the most specific wins.
 */
import type { SensitiveCategory, Severity } from "@/backend/db";

export type SensitiveType =
  | "private_key"
  | "connection_string"
  | "jwt"
  | "bearer_token"
  | "aws_access_key"
  | "aws_secret_key"
  | "credential_field"
  | "email"
  | "credit_card"
  | "aadhaar"
  | "us_ssn"
  | "pan"
  | "phone"
  | "ip_address";

interface Detector {
  type: SensitiveType;
  category: SensitiveCategory;
  severity: Severity;
  pattern: RegExp; // must be global
  validate?: (match: string) => boolean;
  mask: (match: string) => string;
  defaultEnabled: boolean;
}

export interface Finding {
  type: SensitiveType;
  category: SensitiveCategory;
  severity: Severity;
  count: number;
  maskedSample: string;
}

export interface ScanResult {
  redacted: string;
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** Aadhaar numbers carry a Verhoeff check digit; this removes most false positives. */
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![Number(rev[i])]!]!;
  return c === 0;
}

export function verhoeffCheckDigit(digits: string): number {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c]![VERHOEFF_P[(i + 1) % 8]![Number(rev[i])]!]!;
  return VERHOEFF_INV[c]!;
}

const onlyDigits = (s: string) => s.replace(/\D/g, "");
const last = (s: string, n: number) => s.slice(-n);
const NOT_A_VALUE = /^(\*+|x+|null|nil|none|undefined|true|false|\[REDACTED.*|<.*>|\$\{.*\}|%s|\?)$/i;

// ---------------------------------------------------------------------------
// Detectors (order matters)
// ---------------------------------------------------------------------------
const DETECTORS: Detector[] = [
  {
    type: "private_key", category: "secret", severity: "critical", defaultEnabled: true,
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g,
    mask: () => "-----BEGIN PRIVATE KEY----- …",
  },
  {
    type: "connection_string", category: "secret", severity: "critical", defaultEnabled: true,
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"]{1,128}:[^\s@/'"]{1,256}@[^\s/'"]+/gi,
    mask: (m) => m.replace(/\/\/([^:]+):[^@]+@/, "//$1:****@"),
  },
  {
    type: "jwt", category: "secret", severity: "high", defaultEnabled: true,
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    mask: (m) => `${m.slice(0, 10)}…`,
  },
  {
    type: "bearer_token", category: "secret", severity: "high", defaultEnabled: true,
    pattern: /(?<=\b(?:Bearer|Basic|Token)\s+)[A-Za-z0-9\-._~+/]{16,}=*/g,
    mask: (m) => `${m.slice(0, 4)}…`,
  },
  {
    type: "aws_access_key", category: "secret", severity: "critical", defaultEnabled: true,
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    mask: (m) => `${m.slice(0, 4)}************${last(m, 4)}`,
  },
  {
    type: "aws_secret_key", category: "secret", severity: "critical", defaultEnabled: true,
    pattern: /(?<=(?:aws_?secret_?access_?key|secretAccessKey)["']?\s*[:=]\s*["']?)[A-Za-z0-9/+]{40}/gi,
    mask: () => "****",
  },
  {
    type: "credential_field", category: "secret", severity: "high", defaultEnabled: true,
    pattern:
      /(?<=["']?\b(?:password|passwd|pwd|pass|secret|client_?secret|api_?key|apikey|x-api-key|access_?token|refresh_?token|auth_?token|session_?token|private_?key)["']?\s*[:=]\s*["']?)[^\s"',;&}\]]{3,}/gi,
    validate: (m) => !NOT_A_VALUE.test(m),
    mask: () => "****",
  },
  {
    type: "email", category: "pii", severity: "medium", defaultEnabled: true,
    pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g,
    mask: (m) => {
      const [user = "", domain = ""] = m.split("@");
      const dot = domain.lastIndexOf(".");
      return `${user[0] ?? ""}***@${domain[0] ?? ""}***${dot >= 0 ? domain.slice(dot) : ""}`;
    },
  },
  {
    type: "credit_card", category: "pii", severity: "high", defaultEnabled: true,
    pattern: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    validate: (m) => {
      const d = onlyDigits(m);
      return d.length >= 13 && d.length <= 19 && /^(4|5[1-5]|2[2-7]|3[47]|35|6|8[12])/.test(d) &&
        !/^(\d)\1+$/.test(d) && luhnValid(d);
    },
    mask: (m) => `**** **** **** ${last(onlyDigits(m), 4)}`,
  },
  {
    type: "aadhaar", category: "pii", severity: "high", defaultEnabled: true,
    pattern: /(?<![\d-])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g,
    validate: (m) => {
      const d = onlyDigits(m);
      return d.length === 12 && !/^(\d)\1+$/.test(d) && verhoeffValid(d);
    },
    mask: (m) => `XXXX XXXX ${last(onlyDigits(m), 4)}`,
  },
  {
    type: "us_ssn", category: "pii", severity: "high", defaultEnabled: true,
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    mask: (m) => `***-**-${last(m, 4)}`,
  },
  {
    type: "pan", category: "pii", severity: "medium", defaultEnabled: true,
    // Indian PAN: 5 letters (4th = holder type), 4 digits, 1 letter.
    pattern: /\b[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]\b/g,
    mask: (m) => `${m.slice(0, 2)}XXX****${last(m, 1)}`,
  },
  {
    type: "phone", category: "pii", severity: "medium", defaultEnabled: true,
    // International numbers with an explicit + prefix.
    pattern: /(?<![\w+])\+[1-9]\d{0,2}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?![\d])/g,
    validate: (m) => onlyDigits(m).length >= 10 && onlyDigits(m).length <= 15,
    mask: (m) => `******${last(onlyDigits(m), 4)}`,
  },
  {
    type: "phone", category: "pii", severity: "medium", defaultEnabled: true,
    // Indian mobile numbers without a country code (10 digits starting 6–9).
    pattern: /(?<![\w+.-])0?[6-9]\d{4}[\s-]?\d{5}(?![\w.-])/g,
    validate: (m) => !/^0?(\d)\1+$/.test(onlyDigits(m)),
    mask: (m) => `******${last(onlyDigits(m), 4)}`,
  },
  {
    type: "ip_address", category: "pii", severity: "low", defaultEnabled: false,
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    validate: (m) => !/^(10|127|0)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(m),
    mask: (m) => m.replace(/\.\d+\.\d+$/, ".x.x"),
  },
];

export const ALL_SENSITIVE_TYPES = [...new Set(DETECTORS.map((d) => d.type))];
export const DEFAULT_ENABLED_TYPES = new Set(
  DETECTORS.filter((d) => d.defaultEnabled).map((d) => d.type),
);

/** Longest text scanned per event; protects regex CPU time on huge log lines. */
export const MAX_SCAN_CHARS = 32_768;

export function scanSensitive(
  input: string,
  enabled: ReadonlySet<SensitiveType> = DEFAULT_ENABLED_TYPES,
): ScanResult {
  let text = input.length > MAX_SCAN_CHARS ? input.slice(0, MAX_SCAN_CHARS) : input;
  const findings = new Map<SensitiveType, Finding>();

  for (const det of DETECTORS) {
    if (!enabled.has(det.type)) continue;
    det.pattern.lastIndex = 0;
    text = text.replace(det.pattern, (match) => {
      if (det.validate && !det.validate(match)) return match;
      const existing = findings.get(det.type);
      if (existing) existing.count++;
      else findings.set(det.type, {
        type: det.type, category: det.category, severity: det.severity, count: 1, maskedSample: det.mask(match),
      });
      return `[REDACTED:${det.type.toUpperCase()}]`;
    });
  }
  return { redacted: text, findings: [...findings.values()] };
}

/** Redaction only (always applied before storing, even when PII alerting is off). */
export function redact(input: string, enabled?: ReadonlySet<SensitiveType>): string {
  return scanSensitive(input, enabled).redacted;
}

export const SENSITIVE_LABEL: Record<SensitiveType, string> = {
  private_key: "Private keys",
  connection_string: "Connection strings with passwords",
  jwt: "JWT tokens",
  bearer_token: "Bearer/Basic auth tokens",
  aws_access_key: "AWS access key IDs",
  aws_secret_key: "AWS secret access keys",
  credential_field: "Passwords / API keys in fields",
  email: "Email addresses",
  credit_card: "Credit/debit card numbers",
  aadhaar: "Aadhaar numbers",
  us_ssn: "US Social Security numbers",
  pan: "PAN numbers",
  phone: "Phone numbers",
  ip_address: "Public IP addresses",
};
