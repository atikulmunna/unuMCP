import { describe, expect, it } from "vitest";
import type { ExtractedEndpoint } from "@unumcp/openapi";
import { classifyEndpoint, scoreRisk } from "../src/classify";
import { generateToolName, uniqueName } from "../src/naming";
import { assembleToolInput, proposeTools } from "../src/propose";

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

  it("prefers the spec's operationId, in snake_case", () => {
    const named = (operationId: string, method = "get", path = "/x") =>
      generateToolName(ep({ method, path, operationId }), "update");
    // GitHub style: tells merge apart from an ordinary update of the same path.
    expect(named("pulls/merge", "put", "/repos/{owner}/{repo}/pulls/{pull_number}/merge")).toBe("pulls_merge");
    expect(named("issues/list-for-repo")).toBe("issues_list_for_repo");
    expect(named("getPetById")).toBe("get_pet_by_id");
    expect(named("PostCustomersCustomerSources")).toBe("post_customers_customer_sources");
    expect(named("getHTTPResponse")).toBe("get_http_response");
  });

  it("keeps operationId names safe, letter-first, and within 64 characters", () => {
    const SAFE = /^[a-z][a-z0-9_]*$/;
    expect(generateToolName(ep({ operationId: "'); DROP TABLE tools;--" }), "read")).toBe("drop_table_tools");
    expect(generateToolName(ep({ operationId: "2fa-verify" }), "read")).toBe("op_2fa_verify");
    // Nothing usable in the operationId: fall back to method + path.
    expect(generateToolName(ep({ method: "get", path: "/users/{id}", operationId: "!!!" }), "read")).toBe(
      "get_users_by_id",
    );
    const long = generateToolName(ep({ operationId: "actions/get-github-actions-default-workflow-permissions-for-an-enterprise" }), "read");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(SAFE);
    expect(long.endsWith("_")).toBe(false);
  });

  it("keeps disambiguated names within 64 characters", () => {
    const used = new Set<string>();
    const base = "a".repeat(64);
    expect(uniqueName(base, used)).toBe(base);
    const second = uniqueName(base, used);
    expect(second.length).toBe(64);
    expect(second.endsWith("_2")).toBe(true);
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

  it("proposes an endpoint whose body can't be sent disabled, saying why", () => {
    const [draft] = proposeTools([
      ep({ method: "post", path: "/files", summary: "Upload a file", unsupportedRequestBody: "multipart/form-data" }),
    ]);
    expect(draft!.enabledByDefault).toBe(false);
    expect(draft!.description).toMatch(/request body \(multipart\/form-data\) isn't supported/);
    expect((draft!.inputSchema as any).properties.body).toBeUndefined();
  });

  it("proposes deprecated endpoints disabled by default, saying so", () => {
    const [draft] = proposeTools([ep({ method: "get", path: "/legacy", summary: "Legacy list", deprecated: true })]);
    expect(draft!.riskLevel).toBe("low");
    expect(draft!.enabledByDefault).toBe(false);
    expect(draft!.description).toMatch(/Deprecated/);
  });
});

describe("assembleToolInput", () => {
  const props = (e: ExtractedEndpoint, authHeaders?: string[]) =>
    (assembleToolInput(e, { authHeaders }) as any).properties as Record<string, any>;

  it("carries a parameter's own description onto its schema (what the agent sees)", () => {
    const p = props(
      ep({
        parameters: [
          { name: "per_page", in: "query", required: false, description: "Results per page (max 100).", schema: { type: "integer" } },
          { name: "q", in: "query", required: false, description: "ignored", schema: { type: "string", description: "Schema wins." } },
        ],
      }),
    );
    expect(p.per_page).toEqual({ type: "integer", description: "Results per page (max 100)." });
    expect(p.q.description).toBe("Schema wins.");
  });

  it("does not mutate the spec's shared schema objects", () => {
    const shared = { type: "string" } as const;
    assembleToolInput(ep({ parameters: [{ name: "a", in: "query", required: false, description: "A", schema: shared }] }));
    expect(shared).toEqual({ type: "string" });
  });

  it("includes header parameters except ignored and auth-managed ones", () => {
    const p = props(
      ep({
        parameters: [
          { name: "X-GitHub-Api-Version", in: "header", required: false, schema: { type: "string" } },
          { name: "Accept", in: "header", required: false, schema: { type: "string" } },
          { name: "Authorization", in: "header", required: true, schema: { type: "string" } },
          { name: "X-API-Key", in: "header", required: true, schema: { type: "string" } },
          { name: "session", in: "cookie", required: false, schema: { type: "string" } },
        ],
      }),
      ["x-api-key"],
    );
    expect(Object.keys(p)).toEqual(["X-GitHub-Api-Version"]);
  });

  it("never lets a header shadow a same-named path parameter", () => {
    const p = props(
      ep({
        parameters: [
          { name: "id", in: "header", required: false, schema: { type: "integer" } },
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
      }),
    );
    expect(p.id.type).toBe("string");
  });
});
