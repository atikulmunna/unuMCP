import { describe, expect, it } from "vitest";
import { scoreAnswer } from "../src/score";
import type { Task, UsabilityTool } from "../src/types";

const getIssue: UsabilityTool = {
  name: "issues_get",
  description: "Get an issue.",
  method: "get",
  path: "/repos/{owner}/{repo}/issues/{issue_number}",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      issue_number: { type: "integer" },
      // OpenAPI-only keywords must not break validation.
      per_page: { type: "integer", example: 30, format: "int32" },
    },
    required: ["owner", "repo", "issue_number"],
  } as UsabilityTool["inputSchema"],
};
const listIssues: UsabilityTool = { ...getIssue, name: "issues_list", path: "/repos/{owner}/{repo}/issues" };
const candidates = [getIssue, listIssues];

const task: Task = {
  toolName: "issues_get",
  prompt: "Show me issue 42 in octocat/hello-world.",
  expectedArgs: { owner: "octocat", repo: "hello-world", issue_number: 42 },
};
const answer = (tool: string, args: Record<string, unknown>) => ({ tool, arguments: args });

describe("scoreAnswer", () => {
  it("is correct for the right tool with valid, matching arguments", () => {
    const result = scoreAnswer(task, answer("issues_get", { owner: "octocat", repo: "hello-world", issue_number: 42 }), candidates);
    expect(result).toEqual({ outcome: "correct" });
  });

  it("is a wrong tool when the agent picks another candidate", () => {
    const result = scoreAnswer(task, answer("issues_list", { owner: "octocat", repo: "hello-world" }), candidates);
    expect(result.outcome).toBe("wrong_tool");
    expect(result.reason).toMatch(/issues_list/);
  });

  it("is a wrong tool when the agent names a tool it was not offered", () => {
    const result = scoreAnswer(task, answer("get_issue_by_number", { issue_number: 42 }), candidates);
    expect(result.outcome).toBe("wrong_tool");
    expect(result.reason).toMatch(/not one of the tools offered/);
  });

  it("is bad arguments when a required input is missing", () => {
    const result = scoreAnswer(task, answer("issues_get", { owner: "octocat", issue_number: 42 }), candidates);
    expect(result.outcome).toBe("bad_args");
    expect(result.reason).toMatch(/repo/);
  });

  it("is bad arguments when a value has the wrong type", () => {
    const result = scoreAnswer(task, answer("issues_get", { owner: "octocat", repo: "hello-world", issue_number: "forty-two" }), candidates);
    expect(result.outcome).toBe("bad_args");
  });

  it("is bad arguments when the shape is valid but a stated value is wrong", () => {
    const result = scoreAnswer(task, answer("issues_get", { owner: "octocat", repo: "linux", issue_number: 42 }), candidates);
    expect(result.outcome).toBe("bad_args");
    expect(result.reason).toMatch(/repo/);
  });

  it("compares strings trimmed and case-insensitively, numbers exactly", () => {
    const loose = scoreAnswer(task, answer("issues_get", { owner: " OctoCat ", repo: "Hello-World", issue_number: 42 }), candidates);
    expect(loose).toEqual({ outcome: "correct" });
    const offByOne = scoreAnswer(task, answer("issues_get", { owner: "octocat", repo: "hello-world", issue_number: 43 }), candidates);
    expect(offByOne.outcome).toBe("bad_args");
  });

  it("ignores expected values the task did not state", () => {
    const vague: Task = { ...task, expectedArgs: { owner: "octocat", repo: null, issue_number: 42 } };
    const result = scoreAnswer(vague, answer("issues_get", { owner: "octocat", repo: "anything", issue_number: 42 }), candidates);
    expect(result).toEqual({ outcome: "correct" });
  });

  it("is no answer when the agent gave none", () => {
    expect(scoreAnswer(task, null, candidates).outcome).toBe("no_answer");
  });
});
