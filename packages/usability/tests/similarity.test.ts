import { describe, expect, it } from "vitest";
import { pickTargets, selectCandidates, similarity } from "../src/similarity";
import type { UsabilityTool } from "../src/types";

const schema = { type: "object", properties: {} } as UsabilityTool["inputSchema"];
const tool = (name: string, method: string, path: string, tag: string, description: string): UsabilityTool => ({
  name,
  method,
  path,
  tag,
  description,
  inputSchema: schema,
});

// A slice of a GitHub-like API: several tools per resource, plus unrelated ones.
const GITHUB: UsabilityTool[] = [
  tool("issues_get", "get", "/repos/{owner}/{repo}/issues/{issue_number}", "issues", "Get an issue."),
  tool("issues_list", "get", "/repos/{owner}/{repo}/issues", "issues", "List issues in a repository."),
  tool("issues_create", "post", "/repos/{owner}/{repo}/issues", "issues", "Create an issue."),
  tool("issues_update", "patch", "/repos/{owner}/{repo}/issues/{issue_number}", "issues", "Update an issue."),
  tool("pulls_get", "get", "/repos/{owner}/{repo}/pulls/{pull_number}", "pulls", "Get a pull request."),
  tool("pulls_list", "get", "/repos/{owner}/{repo}/pulls", "pulls", "List pull requests."),
  tool("repos_get", "get", "/repos/{owner}/{repo}", "repos", "Get a repository."),
  tool("repos_get_branch", "get", "/repos/{owner}/{repo}/branches/{branch}", "repos", "Get a branch."),
  tool("users_get", "get", "/users/{username}", "users", "Get a user."),
  tool("users_list", "get", "/users", "users", "List users."),
  tool("gists_list", "get", "/gists", "gists", "List gists."),
  tool("gists_create", "post", "/gists", "gists", "Create a gist."),
  tool("orgs_get", "get", "/orgs/{org}", "orgs", "Get an organization."),
  tool("teams_list", "get", "/orgs/{org}/teams", "teams", "List teams."),
  tool("emojis_get", "get", "/emojis", "emojis", "Get emojis."),
  tool("meta_get", "get", "/meta", "meta", "Get GitHub meta information."),
];
const byName = (name: string) => GITHUB.find((t) => t.name === name)!;
const names = (tools: UsabilityTool[]) => tools.map((t) => t.name);

describe("selectCandidates", () => {
  it("offers every tool when there are no more than the candidate count", () => {
    const small = GITHUB.slice(0, 5);
    const candidates = selectCandidates(small[2]!, small);
    expect(names(candidates).sort()).toEqual(names(small).sort());
  });

  it("always includes the target, in name order so its position gives nothing away", () => {
    const candidates = selectCandidates(byName("issues_get"), GITHUB, 6);
    expect(names(candidates)).toContain("issues_get");
    expect(names(candidates)).toEqual([...names(candidates)].sort());
    expect(candidates).toHaveLength(6);
  });

  it("ranks tools on the same resource as the closest look-alikes", () => {
    // Target plus 3: the other issue tools beat everything on other resources.
    const candidates = names(selectCandidates(byName("issues_get"), GITHUB, 4));
    expect(candidates.sort()).toEqual(["issues_create", "issues_get", "issues_list", "issues_update"]);
  });

  it("then prefers related resources over unrelated ones", () => {
    const candidates = names(selectCandidates(byName("issues_get"), GITHUB, 7));
    expect(candidates).toContain("pulls_get");
    for (const unrelated of ["emojis_get", "gists_list", "meta_get", "users_list"]) {
      expect(candidates).not.toContain(unrelated);
    }
  });

  it("is deterministic", () => {
    const shuffled = [...GITHUB].reverse();
    expect(names(selectCandidates(byName("pulls_get"), GITHUB, 7))).toEqual(
      names(selectCandidates(byName("pulls_get"), shuffled, 7)),
    );
  });
});

describe("similarity", () => {
  it("treats plural and singular words as the same", () => {
    const a = tool("issue_get", "get", "/issue/{id}", "issue", "Get an issue.");
    const b = tool("issues_get", "get", "/issues/{id}", "issues", "Get issues.");
    expect(similarity(a, b)).toBeCloseTo(4);
  });

  it("is symmetric", () => {
    expect(similarity(byName("issues_get"), byName("pulls_get"))).toBe(
      similarity(byName("pulls_get"), byName("issues_get")),
    );
  });
});

describe("pickTargets", () => {
  it("caps the number of targets", () => {
    expect(pickTargets(GITHUB, 5)).toHaveLength(5);
    expect(pickTargets(GITHUB, 40)).toHaveLength(GITHUB.length);
  });

  it("tests the most confusable tools first, ties broken by name", () => {
    const ranked = names(pickTargets(GITHUB, 40));
    // Same resource and nearly the same description: the closest pair.
    expect(ranked.slice(0, 2)).toEqual(["pulls_get", "pulls_list"]);
    // Then every tool with an equally close same-resource sibling, in name order.
    expect(ranked.slice(2, 9)).toEqual([
      "gists_create",
      "gists_list",
      "issues_create",
      "issues_get",
      "issues_update",
      "users_get",
      "users_list",
    ]);
    // Tools with no sibling on their resource come last.
    expect(ranked.slice(-2)).toEqual(["emojis_get", "meta_get"]);
  });

  it("is deterministic regardless of input order", () => {
    expect(names(pickTargets(GITHUB, 10))).toEqual(names(pickTargets([...GITHUB].reverse(), 10)));
  });
});
