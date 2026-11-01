import { describe, expect, it } from "vitest";
import { GROUPED_FROM, groupTools, matches, showGrouped } from "./tools";

const tool = (name: string, group: string, enabled = true, path = `/${group}`, riskLevel = "low") => ({
  name,
  description: `Does ${name.replace(/_/g, " ")}`,
  group,
  enabled,
  riskLevel,
  endpoints: [{ endpoint: { path } }],
});

describe("groupTools", () => {
  const tools = [
    tool("list_pulls", "pulls"),
    tool("create_issue", "issues", false),
    tool("list_issues", "issues"),
    tool("merge_pull", "pulls", false, "/pulls/merge", "high"),
  ];

  it("groups in name order, counting what is on and what turning it on would enable", () => {
    expect(groupTools(tools).map((g) => [g.name, g.enabled, g.total, g.canTurnOn, g.tools.map((t) => t.name)])).toEqual([
      ["issues", 1, 2, 1, ["create_issue", "list_issues"]],
      // merge_pull is high risk, so turning the group on leaves it off.
      ["pulls", 1, 2, 0, ["list_pulls", "merge_pull"]],
    ]);
  });

  it("keeps only matching tools and groups, but counts the whole group", () => {
    const found = groupTools(tools, "MERGE");
    expect(found.map((g) => [g.name, g.enabled, g.total, g.tools.map((t) => t.name)])).toEqual([
      ["pulls", 1, 2, ["merge_pull"]],
    ]);
    expect(groupTools(tools, "nothing like this")).toEqual([]);
  });
});

describe("matches", () => {
  it("searches the name, group, description and path", () => {
    const t = tool("get_widget", "widgets", true, "/widgets/{id}");
    expect(["get_widget", "WIDGETS", "does get", "{id}", "  "].map((q) => matches(t, q))).toEqual([true, true, true, true, true]);
    expect(matches(t, "gadget")).toBe(false);
  });
});

describe("showGrouped", () => {
  it("groups long plans that span more than one group", () => {
    const many = (group: string) => Array.from({ length: GROUPED_FROM }, (_, i) => tool(`t${i}`, group));
    expect(showGrouped(many("a"))).toBe(false);
    expect(showGrouped([...many("a").slice(1), tool("x", "b")])).toBe(true);
    expect(showGrouped([tool("x", "a"), tool("y", "b")])).toBe(false);
  });
});
