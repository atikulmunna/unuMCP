import type { ProjectStatus } from "./types";

// The five user-facing stages of the build, in order. The backend's larger
// ProjectStatus enum folds onto these — each status names the stage it concerns
// and that stage's phase.
export const STAGES = [
  { key: "spec", label: "Specification", hint: "Upload & validate the OpenAPI document" },
  { key: "tools", label: "Tool plan", hint: "Review and approve the proposed tools" },
  { key: "generate", label: "Generation", hint: "Produce the TypeScript MCP server" },
  { key: "test", label: "Sandbox tests", hint: "Run the generated suite in isolation" },
  { key: "finish", label: "Completion", hint: "Finalize and download the package" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

// Where a stage sits relative to the user's attention.
//  pending — not reached yet
//  active  — waiting on the user to act
//  busy    — the system is working
//  done    — finished cleanly
//  error   — finished in a failure state
export type Phase = "pending" | "active" | "busy" | "done" | "error";

interface StatusPlacement {
  stage: number;
  phase: Phase;
}

// Single source of truth mapping every ProjectStatus to (stage, phase).
const PLACEMENT: Record<ProjectStatus, StatusPlacement> = {
  DRAFT: { stage: 0, phase: "active" },
  SPEC_UPLOADED: { stage: 0, phase: "busy" },
  SPEC_VALIDATED: { stage: 0, phase: "busy" },
  SPEC_INVALID: { stage: 0, phase: "error" },
  ENDPOINTS_ANALYZED: { stage: 1, phase: "active" },
  TOOLS_PROPOSED: { stage: 1, phase: "active" },
  AWAITING_USER_APPROVAL: { stage: 1, phase: "active" },
  TOOLS_APPROVED: { stage: 2, phase: "active" },
  CODE_GENERATING: { stage: 2, phase: "busy" },
  GENERATION_FAILED: { stage: 2, phase: "error" },
  TEST_GENERATING: { stage: 3, phase: "active" },
  TEST_RUNNING: { stage: 3, phase: "busy" },
  REPAIRING_FAILED_CODE: { stage: 3, phase: "busy" },
  TESTS_FAILED: { stage: 3, phase: "error" },
  SANDBOX_FAILED: { stage: 3, phase: "error" },
  TESTS_PASSED: { stage: 4, phase: "active" },
  PACKAGING: { stage: 4, phase: "busy" },
  PACKAGE_FAILED: { stage: 4, phase: "error" },
  COMPLETED: { stage: 4, phase: "done" },
  COMPLETED_WITH_WARNINGS: { stage: 4, phase: "done" },
  CANCELLED: { stage: 4, phase: "error" },
};

export interface StageView {
  key: StageKey;
  label: string;
  hint: string;
  index: number;
  phase: Phase;
}

/** Render the full pipeline for a status: earlier stages done, current stage in
 *  its phase, later stages pending. */
export function pipeline(status: ProjectStatus): StageView[] {
  const here = PLACEMENT[status];
  const allDone = status === "COMPLETED" || status === "COMPLETED_WITH_WARNINGS";
  return STAGES.map((stage, index) => {
    let phase: Phase;
    if (allDone) phase = "done";
    else if (index < here.stage) phase = "done";
    else if (index > here.stage) phase = "pending";
    else phase = here.phase;
    return { key: stage.key, label: stage.label, hint: stage.hint, index, phase };
  });
}

/** Index of the stage the project is currently sitting on. */
export function currentStage(status: ProjectStatus): number {
  return PLACEMENT[status].stage;
}

export type Tone = "neutral" | "clay" | "ok" | "warn" | "bad" | "run";

interface StatusMeta {
  label: string;
  tone: Tone;
}

const META: Record<ProjectStatus, StatusMeta> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SPEC_UPLOADED: { label: "Spec uploaded", tone: "run" },
  SPEC_VALIDATED: { label: "Spec validated", tone: "run" },
  SPEC_INVALID: { label: "Spec invalid", tone: "bad" },
  ENDPOINTS_ANALYZED: { label: "Ready for tools", tone: "clay" },
  TOOLS_PROPOSED: { label: "Tools proposed", tone: "clay" },
  AWAITING_USER_APPROVAL: { label: "Awaiting approval", tone: "clay" },
  TOOLS_APPROVED: { label: "Plan approved", tone: "clay" },
  CODE_GENERATING: { label: "Generating", tone: "run" },
  GENERATION_FAILED: { label: "Generation failed", tone: "bad" },
  TEST_GENERATING: { label: "Ready to test", tone: "clay" },
  TEST_RUNNING: { label: "Running tests", tone: "run" },
  REPAIRING_FAILED_CODE: { label: "Repairing", tone: "run" },
  TESTS_FAILED: { label: "Tests failed", tone: "bad" },
  SANDBOX_FAILED: { label: "Sandbox failed", tone: "bad" },
  TESTS_PASSED: { label: "Tests passed", tone: "ok" },
  PACKAGING: { label: "Packaging", tone: "run" },
  PACKAGE_FAILED: { label: "Packaging failed", tone: "bad" },
  COMPLETED: { label: "Completed", tone: "ok" },
  COMPLETED_WITH_WARNINGS: { label: "Completed with warnings", tone: "warn" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export function statusMeta(status: ProjectStatus): StatusMeta {
  return META[status];
}

// The single primary action the dashboard should surface for a given status.
// `null` means there's nothing for the user to do (busy or terminal).
export type PrimaryAction =
  | "upload-spec"
  | "propose-tools"
  | "approve-tools"
  | "generate"
  | "run-tests"
  | "complete"
  | "download"
  | null;

export function primaryAction(status: ProjectStatus): PrimaryAction {
  switch (status) {
    case "DRAFT":
    case "SPEC_INVALID":
      return "upload-spec";
    case "ENDPOINTS_ANALYZED":
      return "propose-tools";
    case "TOOLS_PROPOSED":
    case "AWAITING_USER_APPROVAL":
      return "approve-tools";
    case "TOOLS_APPROVED":
    case "GENERATION_FAILED":
      return "generate";
    case "TEST_GENERATING":
    case "TESTS_FAILED":
    case "SANDBOX_FAILED":
      return "run-tests";
    case "TESTS_PASSED":
      return "complete";
    case "COMPLETED":
    case "COMPLETED_WITH_WARNINGS":
      return "download";
    default:
      return null;
  }
}

const RISK_TONE: Record<string, Tone> = {
  low: "ok",
  medium: "warn",
  high: "bad",
  critical: "bad",
};

export function riskTone(risk: string): Tone {
  return RISK_TONE[risk] ?? "neutral";
}

/** A status counts as terminal (no further automated progress) when completed,
 *  cancelled, or sitting in a failure state the user can't directly retry. */
export function isTerminal(status: ProjectStatus): boolean {
  return status === "COMPLETED" || status === "COMPLETED_WITH_WARNINGS" || status === "CANCELLED";
}
