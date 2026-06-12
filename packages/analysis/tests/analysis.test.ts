import { describe, expect, it } from "vitest";
import type { ExtractedEndpoint } from "@unumcp/openapi";
import { classifyEndpoint, scoreRisk } from "../src/classify";
import { generateToolName, uniqueName } from "../src/naming";
import { proposeTools } from "../src/propose";

function ep(partial: Partial<ExtractedEndpoint>): ExtractedEndpoint {
  return {
    method: "get",
    path: "/x",
    tags: [],
    parameters: [],
    authRequired: false,
    deprecated: false,
    ...partial,
  };
}

describe("generateToolName — adversarial inputs (P6-9, §18.4)", () => {
  const SAFE = /^[a-z][a-z0-9_]*$/;

  it("sanitizes path-traversal and injection chars into a safe snake_case name", () => {
    const malicious = [
      "/../../etc/passwd",
      "/files/..%2f..%2fsecret",
      "/x/'); DROP TABLE tools;--",
      "/a/`rm -rf /`",
      "/a/<script>alert(1)</script>",
      "/a/../../../root/.ssh/id_rsa",
    ];
    for (const path of malicious) {
      const name = generateToolName(ep({ path }), "read");
      expect(name, path).toMatch(SAFE);
      expect(name).not.toContain("/");
      expect(name).not.toContain(".");
    }
  });

  it("always yields a valid name even for an empty/param-only path", () => {
    expect(generateToolName(ep({ path: "/{id}" }), "read")).toMatch(SAFE);
    expect(generateToolName(ep({ path: "/" }), "create")).toMatch(SAFE);
  });
});

describe("classifyEndpoint", () => {
  it("classifies by method", () => {
    expect(classifyEndpoint(ep({ method: "get", path: "/users/{id}" }))).toBe("read");
    expect(classifyEndpoint(ep({ method: "post", path: "/users" }))).toBe("create");
    expect(classifyEndpoint(ep({ method: "patch", path: "/users/{id}" }))).toBe("update");
    expect(classifyEndpoint(ep({ method: "delete", path: "/users/{id}" }))).toBe("delete");
  });

  it("detects auth, admin, search, upload, download by signal", () => {
    expect(classifyEndpoint(ep({ method: "post", path: "/login" }))).toBe("auth");
    expect(classifyEndpoint(ep({ method: "get", path: "/admin/stats" }))).toBe("admin");
    expect(classifyEndpoint(ep({ method: "post", path: "/search" }))).toBe("search");
    expect(classifyEndpoint(ep({ method: "post", path: "/files/upload" }))).toBe("upload");
    expect(classifyEndpoint(ep({ method: "get", path: "/reports/export" }))).toBe("download");
  });
});

describe("scoreRisk", () => {
  it("scores reads low, writes medium", () => {
    expect(scoreRisk(ep({ method: "get", path: "/status" }), "read")).toBe("low");
    expect(scoreRisk(ep({ method: "post", path: "/issues" }), "create")).toBe("medium");
  });

  it("escalates destructive and sensitive operations", () => {
    expect(scoreRisk(ep({ method: "delete", path: "/users/{id}" }), "delete")).toBe("critical");
    expect(scoreRisk(ep({ method: "delete", path: "/webhooks/{id}" }), "delete")).toBe("high");
    expect(scoreRisk(ep({ method: "post", path: "/payments" }), "create")).toBe("high");
    expect(scoreRisk(ep({ method: "get", path: "/users/{id}/card" }), "read")).toBe("medium");
  });
});

describe("naming", () => {
  it("generates deterministic verb-first snake_case names", () => {
    expect(generateToolName(ep({ method: "get", path: "/users/{id}" }), "read")).toBe(
      "get_users_by_id",
    );
    expect(generateToolName(ep({ method: "post", path: "/users" }), "create")).toBe("create_users");
    expect(generateToolName(ep({ method: "delete", path: "/webhooks/{id}" }), "delete")).toBe(
      "delete_webhooks",
    );
  });

  it("disambiguates duplicate names", () => {
    const used = new Set<string>();
    expect(uniqueName("get_users", used)).toBe("get_users");
    expect(uniqueName("get_users", used)).toBe("get_users_2");
    expect(uniqueName("get_users", used)).toBe("get_users_3");
  });
});

describe("proposeTools", () => {
  const endpoints: ExtractedEndpoint[] = [
    ep({
      method: "get",
      path: "/users/{id}",
      operationId: "getUser",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      authRequired: true,
    }),
    ep({
      method: "delete",
      path: "/users/{id}",
      operationId: "deleteUser",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    }),
  ];

  it("produces one draft per endpoint with mapping, risk, and input schema", () => {
    const drafts = proposeTools(endpoints);
    expect(drafts).toHaveLength(2);

    const read = drafts.find((d) => d.method === "get")!;
    expect(read.operationType).toBe("read");
    expect((read.inputSchema as any).properties.id.type).toBe("string");
    expect(read.enabledByDefault).toBe(true);

    const del = drafts.find((d) => d.method === "delete")!;
    expect(del.riskLevel).toBe("critical");
    // High/critical risk tools are disabled by default (FR-015).
    expect(del.enabledByDefault).toBe(false);
    expect(del.description).toContain("modifies data");
  });

  it("guarantees unique names across drafts", () => {
    const drafts = proposeTools(endpoints);
    const names = drafts.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
