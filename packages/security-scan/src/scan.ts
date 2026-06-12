/**
 * Static security scan for generated MCP server projects (§16.3, NFR-001).
 *
 * Runs *before packaging* as a defence-in-depth gate over the code unuMCP
 * emits. Although generation is deterministic, parts of the output are derived
 * from an untrusted OpenAPI spec (base URL, tool names/descriptions), so this
 * scan catches anything that smells like an injected secret, an exfiltration
 * host, or dynamic-code / shell execution.
 *
 * Pure and dependency-free: same files in → same findings out, no IO.
 */

export type Severity = "high" | "medium" | "low";

export interface ScanFinding {
  /** Stable rule id, e.g. "hardcoded-secret". */
  rule: string;
  severity: Severity;
  /** File the finding was located in. */
  path: string;
  /** 1-based line number. */
  line: number;
  message: string;
  /** The offending fragment (trimmed/clipped), never a full secret value. */
  excerpt: string;
}

export interface ScanResult {
  /** False when any `high`-severity finding is present — the packaging gate. */
  passed: boolean;
  findings: ScanFinding[];
}

export interface ScanOptions {
  /**
   * Hosts the generated code is legitimately allowed to talk to — normally just
   * the configured API base URL host. Reserved example domains and loopback are
   * always allowed.
   */
  allowedHosts?: string[];
  /**
   * npm packages a generated project may depend on (§16.4). Anything in the
   * generated `package.json` outside this list is a high-severity finding.
   * Defaults to {@link DEFAULT_DEPENDENCY_ALLOWLIST}.
   */
  allowedDependencies?: string[];
}

/**
 * Controlled dependency allowlist for generated MCP servers (§16.4). The
 * deterministic templates only ever emit these; anything else means template
 * drift or injection and must not be packaged.
 */
export const DEFAULT_DEPENDENCY_ALLOWLIST: readonly string[] = [
  "@modelcontextprotocol/sdk",
  "zod",
  "dotenv",
  "undici",
  "axios",
  "typescript",
  "tsx",
  "vitest",
  "@types/node",
];

export interface ScanFile {
  path: string;
  content: string;
}

interface PatternRule {
  rule: string;
  severity: Severity;
  pattern: RegExp;
  message: string;
}

// Known credential shapes — high confidence, so high severity.
const SECRET_RULES: PatternRule[] = [
  {
    rule: "hardcoded-secret",
    severity: "high",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/,
    message: "Embedded private key block.",
  },
  {
    rule: "hardcoded-secret",
    severity: "high",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    message: "Hardcoded AWS access key id.",
  },
  {
    rule: "hardcoded-secret",
    severity: "high",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    message: "Hardcoded GitHub access token.",
  },
  {
    rule: "hardcoded-secret",
    severity: "high",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    message: "Hardcoded Slack token.",
  },
  {
    rule: "hardcoded-secret",
    severity: "high",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/,
    message: "Hardcoded API secret key (sk-…).",
  },
  {
    rule: "hardcoded-secret",
    severity: "high",
    pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/,
    message: "Hardcoded Google API key.",
  },
];

// Identifier-assigned credential literals (e.g. `password: "hunter2hunter2"`).
const SECRET_ASSIGNMENT =
  /\b(?:password|passwd|pwd|secret|client_secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*(['"`])([^'"`]{8,})\1/i;

// Values that are obviously placeholders, not real secrets.
const PLACEHOLDER_VALUE =
  /^(?:your[_-]?|change[_-]?me|changeme|placeholder|example|sample|dummy|test|xxx|<|\$\{|process\.env)/i;

const DANGEROUS_RULES: PatternRule[] = [
  { rule: "dynamic-eval", severity: "high", pattern: /\beval\s*\(/, message: "Use of eval()." },
  {
    rule: "dynamic-eval",
    severity: "high",
    pattern: /\bnew\s+Function\s*\(/,
    message: "Dynamic code via new Function().",
  },
  {
    rule: "shell-exec",
    severity: "high",
    pattern: /\bchild_process\b/,
    message: "Imports child_process (shell execution).",
  },
  {
    rule: "shell-exec",
    severity: "high",
    pattern: /\b(?:execSync|exec|spawnSync|spawn|fork)\s*\(\s*['"`]/,
    message: "Spawns an external process.",
  },
  {
    rule: "dynamic-eval",
    severity: "high",
    pattern: /\b(?:node:)?vm\b.*\brunIn/,
    message: "Executes code in a vm context.",
  },
  {
    rule: "dynamic-eval",
    severity: "high",
    pattern: /\bprocess\s*\.\s*binding\s*\(/,
    message: "Uses process.binding (internal native access).",
  },
];

const OBFUSCATION_RULES: PatternRule[] = [
  { rule: "obfuscation", severity: "medium", pattern: /\batob\s*\(/, message: "Base64 decode via atob()." },
  {
    rule: "obfuscation",
    severity: "medium",
    pattern: /Buffer\.from\s*\([^)]*['"`]base64['"`]\s*\)/,
    message: "Base64-decoded buffer (possible payload).",
  },
  {
    rule: "obfuscation",
    severity: "medium",
    pattern: /(?:\\x[0-9a-fA-F]{2}){8,}/,
    message: "Long hex-escaped string (obfuscation).",
  },
  {
    rule: "obfuscation",
    severity: "medium",
    pattern: /(?:\\u[0-9a-fA-F]{4}){8,}/,
    message: "Long unicode-escaped string (obfuscation).",
  },
  {
    rule: "obfuscation",
    severity: "medium",
    pattern: /\bString\.fromCharCode\s*\(/,
    message: "String.fromCharCode (possible obfuscation).",
  },
];

const URL_PATTERN = /https?:\/\/([^/\s"'`)\\<>]+)/g;

// Reserved/loopback hosts that are always safe to reference.
const RESERVED_SUFFIXES = [".example.com", ".example.net", ".example.org", ".example.test", ".example.edu"];
const RESERVED_EXACT = new Set([
  "example.com",
  "example.net",
  "example.org",
  "example.test",
  "example.edu",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
]);

function hostOf(authority: string): string {
  // Strip any userinfo and port: user:pass@host:port -> host
  const afterUser = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  const host = afterUser.split(":")[0] ?? afterUser;
  return host.toLowerCase();
}

function isSafeHost(host: string, allowed: Set<string>): boolean {
  if (allowed.has(host) || RESERVED_EXACT.has(host)) return true;
  return RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function clip(text: string, max = 120): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

/**
 * Scan a set of generated files. Returns every finding; `passed` is false if any
 * `high`-severity finding exists (the signal to refuse packaging).
 */
export function scanGeneratedProject(files: ScanFile[], options: ScanOptions = {}): ScanResult {
  const allowed = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const allowedDeps = new Set(options.allowedDependencies ?? DEFAULT_DEPENDENCY_ALLOWLIST);
  const findings: ScanFinding[] = [];

  for (const file of files) {
    if (file.path === "package.json" || file.path.endsWith("/package.json")) {
      findings.push(...checkDependencies(file, allowedDeps));
    }

    const lines = file.content.split("\n");
    lines.forEach((line, idx) => {
      const lineNo = idx + 1;

      const record = (rule: PatternRule, matched: string) => {
        findings.push({
          rule: rule.rule,
          severity: rule.severity,
          path: file.path,
          line: lineNo,
          message: rule.message,
          excerpt: clip(matched),
        });
      };

      for (const rule of [...SECRET_RULES, ...DANGEROUS_RULES, ...OBFUSCATION_RULES]) {
        const m = rule.pattern.exec(line);
        if (m) record(rule, line);
      }

      const assign = SECRET_ASSIGNMENT.exec(line);
      const assignedValue = assign?.[2];
      if (assignedValue && !PLACEHOLDER_VALUE.test(assignedValue)) {
        findings.push({
          rule: "hardcoded-secret",
          severity: "high",
          path: file.path,
          line: lineNo,
          // Never echo the secret value itself.
          message: "Credential assigned to a string literal.",
          excerpt: clip(line.replace(assignedValue, "***")),
        });
      }

      URL_PATTERN.lastIndex = 0;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = URL_PATTERN.exec(line)) !== null) {
        const host = hostOf(urlMatch[1] ?? "");
        if (!isSafeHost(host, allowed)) {
          findings.push({
            rule: "unexpected-host",
            severity: "high",
            path: file.path,
            line: lineNo,
            message: `References an unexpected host "${host}" (only the configured API host is allowed).`,
            excerpt: clip(urlMatch[0]),
          });
        }
      }
    });
  }

  const passed = !findings.some((f) => f.severity === "high");
  return { passed, findings };
}

/** Parse a generated package.json and flag any dependency outside the allowlist (§16.4). */
function checkDependencies(file: ScanFile, allowed: Set<string>): ScanFinding[] {
  let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(file.content);
  } catch {
    // A malformed package.json is a generation bug, not a security finding here.
    return [];
  }
  const lines = file.content.split("\n");
  const lineOf = (name: string): number => {
    const idx = lines.findIndex((l) => l.includes(`"${name}"`));
    return idx >= 0 ? idx + 1 : 1;
  };
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  const findings: ScanFinding[] = [];
  for (const name of names) {
    if (!allowed.has(name)) {
      findings.push({
        rule: "disallowed-dependency",
        severity: "high",
        path: file.path,
        line: lineOf(name),
        message: `Dependency "${name}" is not on the allowlist (§16.4).`,
        excerpt: clip(`"${name}"`),
      });
    }
  }
  return findings;
}

/** Human-readable one-line summary of a scan result (for logs / errors). */
export function summarizeScan(result: ScanResult): string {
  if (result.findings.length === 0) return "security scan: clean (0 findings)";
  const counts = result.findings.reduce<Record<Severity, number>>(
    (acc, f) => ((acc[f.severity] = (acc[f.severity] ?? 0) + 1), acc),
    { high: 0, medium: 0, low: 0 },
  );
  return `security scan: ${counts.high} high, ${counts.medium} medium, ${counts.low} low`;
}
