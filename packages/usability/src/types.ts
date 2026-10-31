import type { JsonSchema } from "@unumcp/openapi";

/** What the simulated agent sees of a tool, plus where it lives in the API. */
export interface UsabilityTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  method: string;
  path: string;
  tag?: string;
}

/** A task written for one target tool. */
export interface Task {
  toolName: string;
  prompt: string;
  /** Argument values the task states; null means "not stated, don't check". */
  expectedArgs: Record<string, unknown>;
}

/** What the simulated agent answered. */
export interface AgentAnswer {
  tool: string;
  arguments: Record<string, unknown>;
}

export type Outcome = "correct" | "wrong_tool" | "bad_args" | "no_answer";

export interface TaskOutcome {
  outcome: Outcome;
  /** Why the answer is not correct, e.g. the schema error or the mismatched value. */
  reason?: string;
}
