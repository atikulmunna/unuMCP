import Ajv, { type ValidateFunction } from "ajv";
import type { AgentAnswer, Task, TaskOutcome, UsabilityTool } from "./types";

// OpenAPI schemas carry keywords JSON Schema doesn't know (`example`,
// `nullable`) and formats like `int32`; they describe, they don't constrain.
const ajv = new Ajv({ strict: false, validateFormats: false });
const validators = new WeakMap<object, ValidateFunction>();

function validatorFor(tool: UsabilityTool): ValidateFunction {
  const schema = tool.inputSchema as object;
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  return validate;
}

/**
 * Grade one agent answer against its task. In order: no answer, the wrong
 * tool (including one that was never offered), arguments the tool's schema
 * rejects or that miss a value the task stated, then correct.
 */
export function scoreAnswer(task: Task, answer: AgentAnswer | null, candidates: UsabilityTool[]): TaskOutcome {
  if (!answer) return { outcome: "no_answer", reason: "The agent gave no usable answer." };

  if (answer.tool !== task.toolName) {
    const offered = candidates.some((c) => c.name === answer.tool);
    return {
      outcome: "wrong_tool",
      reason: offered
        ? `Picked ${answer.tool} instead of ${task.toolName}.`
        : `Picked ${answer.tool}, which is not one of the tools offered.`,
    };
  }

  const target = candidates.find((c) => c.name === task.toolName);
  if (target) {
    const validate = validatorFor(target);
    if (!validate(answer.arguments)) {
      return { outcome: "bad_args", reason: ajv.errorsText(validate.errors, { dataVar: "arguments" }) };
    }
  }

  for (const [key, expected] of Object.entries(task.expectedArgs)) {
    if (expected === null || expected === undefined) continue;
    const actual = answer.arguments[key];
    if (!sameValue(expected, actual)) {
      return {
        outcome: "bad_args",
        reason: `${key} should be ${JSON.stringify(expected)}, got ${JSON.stringify(actual ?? null)}.`,
      };
    }
  }
  return { outcome: "correct" };
}

/**
 * Whether the agent's value says what the task meant. Strings are compared
 * trimmed and case-insensitively; numbers and booleans exactly. Types are the
 * schema's job, so 42 and "42" match here. Every element or key the task
 * stated must be present; extra ones are fine.
 */
function sameValue(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((e) => actual.some((a) => sameValue(e, a)));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(
      ([key, value]) => value === null || value === undefined || sameValue(value, (actual as Record<string, unknown>)[key]),
    );
  }
  if (actual === null || actual === undefined || typeof actual === "object") return false;
  if (typeof expected === "string") return expected.trim().toLowerCase() === String(actual).trim().toLowerCase();
  return expected === actual || String(expected) === String(actual).trim();
}
