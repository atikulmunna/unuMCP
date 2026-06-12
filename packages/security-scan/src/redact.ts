/**
 * Secret redaction for anything the platform persists or logs (NFR-001: "redact
 * secrets from logs", "mask secrets in UI"). Applied to sandbox log excerpts and
 * stored error messages so a token that leaks into output never lands in the DB
 * or the UI.
 *
 * Pure and dependency-free. Deliberately conservative: it redacts known
 * credential shapes, auth-header values, and secret-named key/value pairs — it
 * does not blanket-redact every long string, to keep diagnostic logs readable.
 */

const REDACTED = "***REDACTED***";

// Known credential shapes (global so every occurrence is replaced).
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z_\-]{35}\b/g,
];

// "Authorization: Bearer xxx" / "authorization":"token xxx" — redact the value.
const AUTH_HEADER =
  /\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)(?:bearer\s+|token\s+|basic\s+)?[A-Za-z0-9._\-+/=]{4,}/gi;

// secret-named key followed by a value: `password=...`, `"api_key": "..."`.
const SECRET_KV =
  /\b(password|passwd|pwd|secret|client_secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key)(\s*["']?\s*[:=]\s*["']?)([^\s"'`,;)]{6,})/gi;

// Values that are clearly not real secrets — leave them legible.
const PLACEHOLDER_VALUE =
  /^(?:your[_-]?|change[_-]?me|changeme|placeholder|example|sample|dummy|xxx|<|\$\{|process\.env|undefined|null|true|false)/i;

/** Redact secrets from arbitrary text (logs, error messages). Pure. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(AUTH_HEADER, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  out = out.replace(SECRET_KV, (match, key: string, sep: string, value: string) =>
    PLACEHOLDER_VALUE.test(value) ? match : `${key}${sep}${REDACTED}`,
  );
  return out;
}
