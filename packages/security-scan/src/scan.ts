/**
 * Static security scan for generated MCP server projects (§16.3, NFR-001).
 *
 * Runs *before packaging* as a defence-in-depth gate over the code unuMCP
 * emits. Although generation is deterministic, parts of the output are derived
 * from an untrusted OpenAPI spec (base URL, tool names/descriptions), so this
 * scan catches anything that smells like an injected secret, an exfiltration
 * host, or dynamic-code / shell execution. Code is read through the TypeScript
 * parser (see `code-view.ts`), so documentation strings and comments, such as
 * a spec's docs links, aren't mistaken for behaviour.
 *
 * Pure: same files in → same findings out, no IO.
 */
import { sourceViews } from "./code-view";

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
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
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

/** Second-level labels under country TLDs (`example.co.uk`, `example.com.au`). */
const SECOND_LEVEL_LABELS = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/**
 * A host's registrable site, heuristically: `docs.github.com` → `github.com`,
 * `api.example.co.uk` → `example.co.uk`. Good enough to tell an API's own docs
 * apart from a foreign host, without shipping the public suffix list.
 */
function siteOf(host: string): string {
  const labels = host.split(".");
  const tld = labels[labels.length - 1] ?? "";
  const sld = labels[labels.length - 2] ?? "";
  const size = labels.length >= 3 && tld.length === 2 && SECOND_LEVEL_LABELS.has(sld) ? 3 : 2;
  return labels.slice(-size).join(".");
}

/**
 * "...send/post/upload/forward ... to <url>": agent-facing text telling the
 * agent to deliver something to a host (the shape of a tool-poisoning payload),
 * as opposed to a reference link.
 */
const SEND_INSTRUCTION =
  /\b(?:send|post|upload|forward|submit|transmit|exfiltrate|leak|share|report)(?:s|ed|ing)?\b[^.!?\n]*\bto\s*\W?\s*$/i;

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
  const allowedSites = new Set([...allowed].map(siteOf));
  const allowedDeps = new Set(options.allowedDependencies ?? DEFAULT_DEPENDENCY_ALLOWLIST);
  const findings: ScanFinding[] = [];

  for (const file of files) {
    if (file.path === "package.json" || file.path.endsWith("/package.json")) {
      findings.push(...checkDependencies(file, allowedDeps));
    }

    // Secrets are looked for everywhere (a key is a leak even inside a
    // description). Behavioural rules run on what can execute: for code, the
    // parser-backed view with comments and documentation strings blanked; for
    // Markdown, nothing; for anything else (JSON, .env.example), the raw text.
    // Agent-facing documentation strings get their own link rule below.
    const lines = file.content.split("\n");
    const views = viewsOf(file);
    const behaviourLines = views.behaviour?.split("\n");
    const docLines = views.docs?.split("\n");

    lines.forEach((line, idx) => {
      const lineNo = idx + 1;
      const codeLine = behaviourLines?.[idx];

      // Links in agent-facing text: the API's own site is documentation; a
      // foreign host is worth a look (medium); telling the agent to send
      // something to a foreign host is a tool-poisoning payload (high).
      const docLine = docLines?.[idx];
      if (docLine?.trim()) {
        URL_PATTERN.lastIndex = 0;
        let docUrl: RegExpExecArray | null;
        while ((docUrl = URL_PATTERN.exec(docLine)) !== null) {
          const host = hostOf(docUrl[1] ?? "");
          if (isSafeHost(host, allowed) || allowedSites.has(siteOf(host))) continue;
          const instructs = SEND_INSTRUCTION.test(docLine.slice(Math.max(0, docUrl.index - 160), docUrl.index));
          findings.push({
            rule: instructs ? "doc-send-instruction" : "outside-doc-link",
            severity: instructs ? "high" : "medium",
            path: file.path,
            line: lineNo,
            message: instructs
              ? `Agent-facing text tells the agent to send data to "${host}" (possible tool poisoning).`
              : `Agent-facing text links to "${host}", outside the API's own site; review it (MCP clients pass descriptions to the agent).`,
            excerpt: clip(docUrl[0]),
          });
        }
      }

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

      for (const rule of SECRET_RULES) {
        if (rule.pattern.test(line)) record(rule, line);
      }
      if (codeLine !== undefined) {
        for (const rule of [...DANGEROUS_RULES, ...OBFUSCATION_RULES]) {
          if (rule.pattern.test(codeLine)) record(rule, line);
        }
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

      if (codeLine === undefined) return;
      URL_PATTERN.lastIndex = 0;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = URL_PATTERN.exec(codeLine)) !== null) {
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

const CODE_FILE = /\.[cm]?[jt]sx?$/i;
const MARKDOWN_FILE = /\.(md|markdown)$/i;

/**
 * The texts the rules see. `behaviour`: `null` for documentation files, the
 * comment/doc-string-masked view for code (raw text if it doesn't parse), the
 * raw text otherwise. `docs`: a code file's agent-facing documentation strings
 * (`null` when there are none to separate out, including unparseable files,
 * whose raw text already goes through the strict behaviour rules).
 */
function viewsOf(file: ScanFile): { behaviour: string | null; docs: string | null } {
  if (MARKDOWN_FILE.test(file.path)) return { behaviour: null, docs: null };
  if (!CODE_FILE.test(file.path)) return { behaviour: file.content, docs: null };
  const views = sourceViews(file.path, file.content);
  return views ? { behaviour: views.code, docs: views.docs } : { behaviour: file.content, docs: null };
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
