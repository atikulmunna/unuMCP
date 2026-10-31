import {
  pickTargets,
  scoreAnswer,
  selectCandidates,
  type Task,
  type TaskOutcome,
  type UsabilityTool,
} from "@unumcp/usability";
import type { ChosenCall, FixRequest, ProposedFix, ToolView, UsabilityCall, WrittenTask } from "@unumcp/llm";
import { chunk, mapWithConcurrency } from "../common/concurrency";

const TASKS_PER_CALL = 10;
/** More unanswered tasks than this share means the provider, not the tools, failed. */
const NO_ANSWER_LIMIT = 0.25;

/** The LLM calls a check makes, passed in so the loop knows nothing of the provider. */
export interface CheckCalls {
  writeTasks(tools: ToolView[]): Promise<UsabilityCall<WrittenTask[]>>;
  chooseTool(request: string, candidates: ToolView[]): Promise<UsabilityCall<ChosenCall | null>>;
  proposeFixes(requests: FixRequest[]): Promise<UsabilityCall<Map<string, ProposedFix>>>;
}

export interface CheckOptions {
  maxTasks: number;
  concurrency: number;
  maxCalls: number;
  /** False for proposed text that looks like a prompt-injection attempt. */
  isSafeText(text: string): boolean;
}

/** Calls and tokens spent so far; read even when the check fails part way. */
export interface Meter {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
}

export interface TaskResult {
  task: Task;
  candidateNames: string[];
  answer: ChosenCall | null;
  outcome: TaskOutcome;
}

export interface OfferedFix {
  toolName: string;
  afterName?: string;
  afterDescription: string;
  missesFixed: number;
}

export interface CheckResult {
  /** Baseline outcome of every task. */
  results: TaskResult[];
  answeredCount: number;
  baselineCorrect: number;
  /** Correct answers with the offered fixes applied; null when none are offered. */
  fixedCorrect: number | null;
  fixes: OfferedFix[];
  note?: string;
}

/** The check hit its LLM call ceiling. */
export class CallLimitReached extends Error {}

type Calls = { [K in keyof CheckCalls]: (...args: Parameters<CheckCalls[K]>) => Promise<Awaited<ReturnType<CheckCalls[K]>>["value"]> };
type Fixes = Map<string, ProposedFix>;

/**
 * One agent usability check: write a task per target tool, have the agent
 * answer each against the target's look-alikes, then propose fixes for the
 * misses and keep only those that turn a miss into a hit without breaking a
 * hit. At most two re-score passes.
 */
export async function runUsabilityCheck(
  tools: UsabilityTool[],
  calls: CheckCalls,
  options: CheckOptions,
  meter: Meter,
): Promise<CheckResult> {
  const spend = metered(calls, options.maxCalls, meter);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const answer = (items: Pick<TaskResult, "task" | "candidateNames">[], fixes: Fixes) =>
    answerAll(items, byName, fixes, spend, options.concurrency);

  const tasks = await writeAllTasks(pickTargets(tools, options.maxTasks), spend, options.concurrency);
  if (tasks.length === 0) throw new Error("The model wrote no usable tasks.");

  const baseline = await answer(
    tasks.map((task) => ({ task, candidateNames: selectCandidates(byName.get(task.toolName)!, tools).map((t) => t.name) })),
    new Map(),
  );
  const unanswered = baseline.filter((r) => r.outcome.outcome === "no_answer").length;
  if (unanswered > NO_ANSWER_LIMIT * baseline.length) {
    throw new Error(`${unanswered} of ${baseline.length} tasks got no answer; the provider may be rate limiting. Try again later.`);
  }
  const summary = { results: baseline, answeredCount: baseline.length - unanswered, baselineCorrect: countCorrect(baseline) };
  const noFixes = (note?: string): CheckResult => ({ ...summary, fixedCorrect: null, fixes: [], ...(note ? { note } : {}) });

  const misses = baseline.filter(isMiss);
  if (misses.length === 0) return noFixes();

  let proposed: Fixes;
  try {
    proposed = screen(await spend.proposeFixes(fixRequests(misses, byName)), tools, options.isSafeText);
  } catch (err) {
    if (err instanceof CallLimitReached) throw err;
    return noFixes(`Fixes could not be proposed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (proposed.size === 0) return noFixes("No usable fixes were proposed.");

  // Pass 1 with every proposed fix; pass 2 with only the survivors, if any were dropped.
  let final = rescore(baseline, await answer(affectedBy(baseline, proposed), proposed));
  const survivors = survivingFixes(baseline, final, proposed);
  if (survivors.size === 0) return noFixes("No proposed fix improved the score without breaking another tool.");
  if (survivors.size < proposed.size) final = rescore(baseline, await answer(affectedBy(baseline, survivors), survivors));

  const offered = [...survivors]
    .map(([toolName, fix]) => ({
      toolName,
      ...(fix.name ? { afterName: fix.name } : {}),
      afterDescription: fix.description,
      missesFixed: missesFixedBy(toolName, baseline, final),
    }))
    .filter((fix) => fix.missesFixed > 0);
  return offered.length > 0 ? { ...summary, fixedCorrect: countCorrect(final), fixes: offered } : noFixes();
}

/** Wrap the calls so each counts against the ceiling and adds its tokens to the meter. */
function metered(calls: CheckCalls, maxCalls: number, meter: Meter): Calls {
  const spend = async <T>(call: () => Promise<UsabilityCall<T>>): Promise<T> => {
    if (++meter.calls > maxCalls) throw new CallLimitReached(`Stopped at the limit of ${maxCalls} LLM calls for one check.`);
    const result = await call();
    meter.inputTokens += result.usage.inputTokens;
    meter.outputTokens += result.usage.outputTokens;
    meter.model ??= result.model;
    return result.value;
  };
  return {
    writeTasks: (tools) => spend(() => calls.writeTasks(tools)),
    chooseTool: (request, candidates) => spend(() => calls.chooseTool(request, candidates)),
    proposeFixes: (requests) => spend(() => calls.proposeFixes(requests)),
  };
}

async function writeAllTasks(targets: UsabilityTool[], spend: Calls, concurrency: number): Promise<Task[]> {
  const batches = await mapWithConcurrency(chunk(targets, TASKS_PER_CALL), concurrency, (batch) =>
    spend.writeTasks(batch.map((t) => viewOf(t))),
  );
  return batches.flat().map((t) => ({ toolName: t.toolName, prompt: t.prompt, expectedArgs: t.expectedArgs }));
}

/**
 * Have the agent answer each task, with `fixes` applied to the candidates it
 * sees. A failed call is "no answer"; hitting the call ceiling lets the calls
 * already in flight finish, then stops the check.
 */
async function answerAll(
  items: Pick<TaskResult, "task" | "candidateNames">[],
  byName: Map<string, UsabilityTool>,
  fixes: Fixes,
  spend: Calls,
  concurrency: number,
): Promise<TaskResult[]> {
  const stop: { reason: CallLimitReached | null } = { reason: null };
  const results = await mapWithConcurrency(items, concurrency, async ({ task, candidateNames }) => {
    const candidates = candidateNames.map((n) => byName.get(n)!);
    let answer: ChosenCall | null = null;
    try {
      answer = await spend.chooseTool(task.prompt, candidates.map((c) => viewOf(c, fixes.get(c.name))));
    } catch (err) {
      if (err instanceof CallLimitReached) stop.reason = err;
    }
    const mapped = answer ? { ...answer, tool: originalName(answer.tool, fixes) } : null;
    return { task, candidateNames, answer: mapped, outcome: scoreAnswer(task, mapped, candidates) };
  });
  if (stop.reason) throw stop.reason;
  return results;
}

/** What the agent sees of a tool, with a proposed fix applied. */
function viewOf(tool: UsabilityTool, fix?: ProposedFix): ToolView {
  return { name: fix?.name ?? tool.name, description: fix?.description ?? tool.description, inputSchema: tool.inputSchema };
}

/** A proposed rename means the agent may answer with the new name. */
function originalName(name: string, fixes: Fixes): string {
  for (const [original, fix] of fixes) if (fix.name === name) return original;
  return name;
}

const isMiss = (r: TaskResult) => r.outcome.outcome === "wrong_tool" || r.outcome.outcome === "bad_args";
const isCorrect = (r: TaskResult) => r.outcome.outcome === "correct";
const countCorrect = (results: TaskResult[]) => results.filter(isCorrect).length;

/** One request per tool the agent got wrong, listing what went wrong each time. */
function fixRequests(misses: TaskResult[], byName: Map<string, UsabilityTool>): FixRequest[] {
  const requests = new Map<string, FixRequest>();
  for (const { task, answer, outcome } of misses) {
    const tool = byName.get(task.toolName)!;
    const request: FixRequest = requests.get(tool.name) ?? { toolName: tool.name, description: tool.description, misses: [] };
    const picked = outcome.outcome === "wrong_tool" && answer ? byName.get(answer.tool) : undefined;
    request.misses.push({
      request: task.prompt,
      ...(picked ? { picked: { name: picked.name, description: picked.description } } : {}),
      ...(outcome.outcome === "bad_args" && outcome.reason ? { problem: outcome.reason } : {}),
    });
    requests.set(tool.name, request);
  }
  return [...requests.values()];
}

/**
 * Drop fixes whose text looks like a prompt-injection attempt, and a new name
 * that would clash with another tool or another fix (keeping its description).
 */
function screen(proposed: Fixes, tools: UsabilityTool[], isSafeText: (text: string) => boolean): Fixes {
  const taken = new Set(tools.map((t) => t.name));
  const screened: Fixes = new Map();
  for (const [toolName, fix] of proposed) {
    if (!isSafeText(fix.description)) continue;
    if (fix.name && !taken.has(fix.name)) {
      taken.add(fix.name);
      screened.set(toolName, fix);
    } else {
      screened.set(toolName, { description: fix.description });
    }
  }
  return screened;
}

/**
 * Tasks a set of fixes could change: misses on a fixed tool, and hits whose
 * candidates include a fixed tool (to catch a fix that steals another's hit).
 */
function affectedBy(baseline: TaskResult[], fixes: Fixes): TaskResult[] {
  return baseline.filter(
    (r) => (isMiss(r) && fixes.has(r.task.toolName)) || (isCorrect(r) && r.candidateNames.some((n) => fixes.has(n))),
  );
}

/** Baseline outcomes with the re-scored ones swapped in; an unanswered re-score changes nothing. */
function rescore(baseline: TaskResult[], rescored: TaskResult[]): TaskResult[] {
  const byTask = new Map(rescored.map((r) => [r.task, r]));
  return baseline.map((r) => {
    const updated = byTask.get(r.task);
    return updated && updated.outcome.outcome !== "no_answer" ? updated : r;
  });
}

/**
 * Fixes that turned at least one miss on their tool into a hit and broke no
 * hit. A broken hit is blamed on the changed tool the agent picked instead,
 * or, if it picked an unchanged one, on every changed candidate.
 */
function survivingFixes(baseline: TaskResult[], after: TaskResult[], fixes: Fixes): Fixes {
  const survivors: Fixes = new Map();
  for (const [toolName, fix] of fixes) {
    const fixed = missesFixedBy(toolName, baseline, after);
    const broke = baseline.some((before, i) => {
      const now = after[i]!;
      if (!isCorrect(before) || isCorrect(now)) return false;
      const picked = now.answer?.tool;
      const blamed = picked && fixes.has(picked) ? [picked] : now.candidateNames.filter((n) => fixes.has(n));
      return blamed.includes(toolName);
    });
    if (fixed > 0 && !broke) survivors.set(toolName, fix);
  }
  return survivors;
}

function missesFixedBy(toolName: string, baseline: TaskResult[], after: TaskResult[]): number {
  return baseline.filter((before, i) => before.task.toolName === toolName && isMiss(before) && isCorrect(after[i]!)).length;
}
