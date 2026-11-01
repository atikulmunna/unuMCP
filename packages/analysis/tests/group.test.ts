import { describe, expect, it } from "vitest";
import { toolGroup } from "../src/group";

describe("toolGroup", () => {
  it("uses the endpoint's tag, as a snake_case name", () => {
    expect(toolGroup({ tag: "issues", path: "/repos/{owner}/{repo}/issues" })).toBe("issues");
    expect(toolGroup({ tag: "Pull Requests", path: "/x" })).toBe("pull_requests");
    expect(toolGroup({ tag: "billingPortal", path: "/x" })).toBe("billing_portal");
    expect(toolGroup({ tag: "Repos & Teams", path: "/x" })).toBe("repos_teams");
  });

  it("falls back to the first literal path segment, then to other", () => {
    expect(toolGroup({ tag: null, path: "/customers/{customerId}/invoices" })).toBe("customers");
    expect(toolGroup({ tag: "  ", path: "/{id}/widgets" })).toBe("widgets");
    expect(toolGroup({ path: "/" })).toBe("other");
    expect(toolGroup({ tag: "&&", path: "/{id}" })).toBe("other");
  });
});
