import { describe, expect, it } from "vitest";
import {
  STAGES,
  currentStage,
  isTerminal,
  pipeline,
  primaryAction,
  statusMeta,
} from "./status";
import type { ProjectStatus } from "./types";

const ALL_STATUSES: ProjectStatus[] = [
  "DRAFT", "SPEC_UPLOADED", "SPEC_VALIDATED", "ENDPOINTS_ANALYZED", "TOOLS_PROPOSED",
  "AWAITING_USER_APPROVAL", "TOOLS_APPROVED", "CODE_GENERATING", "TEST_GENERATING",
  "TEST_RUNNING", "REPAIRING_FAILED_CODE", "TESTS_PASSED", "PACKAGING", "COMPLETED",
  "COMPLETED_WITH_WARNINGS", "SPEC_INVALID", "GENERATION_FAILED", "TESTS_FAILED",
  "SANDBOX_FAILED", "PACKAGE_FAILED", "CANCELLED",
];

describe("pipeline()", () => {
  it("returns one view per stage for every status", () => {
    for (const status of ALL_STATUSES) {
      expect(pipeline(status)).toHaveLength(STAGES.length);
    }
  });

  it("marks earlier stages done and later stages pending around the current one", () => {
    const views = pipeline("TOOLS_APPROVED"); // stage 2, active
    expect(views[0]?.phase).toBe("done"); // spec
    expect(views[1]?.phase).toBe("done"); // tools
    expect(views[2]?.phase).toBe("active"); // generate
    expect(views[3]?.phase).toBe("pending"); // test
    expect(views[4]?.phase).toBe("pending"); // finish
  });

  it("treats both completion states as fully done", () => {
    for (const status of ["COMPLETED", "COMPLETED_WITH_WARNINGS"] as ProjectStatus[]) {
      expect(pipeline(status).every((s) => s.phase === "done")).toBe(true);
    }
  });

  it("surfaces a failure as an error on its own stage, not later ones", () => {
    const views = pipeline("TESTS_FAILED"); // stage 3
    expect(views[2]?.phase).toBe("done"); // generation completed
    expect(views[3]?.phase).toBe("error"); // tests
    expect(views[4]?.phase).toBe("pending");
  });

  it("keeps draft entirely at the start", () => {
    const views = pipeline("DRAFT");
    expect(views[0]?.phase).toBe("active");
    expect(views.slice(1).every((s) => s.phase === "pending")).toBe(true);
  });
});

describe("currentStage()", () => {
  it("advances monotonically along the happy path", () => {
    const happyPath: ProjectStatus[] = [
      "DRAFT", "ENDPOINTS_ANALYZED", "TOOLS_APPROVED", "TEST_GENERATING", "TESTS_PASSED", "COMPLETED",
    ];
    const stages = happyPath.map(currentStage);
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i]!).toBeGreaterThanOrEqual(stages[i - 1]!);
    }
  });
});

describe("primaryAction()", () => {
  it("offers the right next action at each decision point", () => {
    expect(primaryAction("DRAFT")).toBe("upload-spec");
    expect(primaryAction("ENDPOINTS_ANALYZED")).toBe("propose-tools");
    expect(primaryAction("TOOLS_PROPOSED")).toBe("approve-tools");
    expect(primaryAction("TOOLS_APPROVED")).toBe("generate");
    expect(primaryAction("TEST_GENERATING")).toBe("run-tests");
    expect(primaryAction("TESTS_PASSED")).toBe("complete");
    expect(primaryAction("COMPLETED")).toBe("download");
    expect(primaryAction("COMPLETED_WITH_WARNINGS")).toBe("download");
  });

  it("lets the user retry the stage that failed", () => {
    expect(primaryAction("SPEC_INVALID")).toBe("upload-spec");
    expect(primaryAction("GENERATION_FAILED")).toBe("generate");
    expect(primaryAction("TESTS_FAILED")).toBe("run-tests");
    expect(primaryAction("SANDBOX_FAILED")).toBe("run-tests");
  });

  it("offers nothing while the system is busy", () => {
    expect(primaryAction("CODE_GENERATING")).toBeNull();
    expect(primaryAction("TEST_RUNNING")).toBeNull();
    expect(primaryAction("PACKAGING")).toBeNull();
  });
});

describe("statusMeta() / isTerminal()", () => {
  it("has a label and tone for every status", () => {
    for (const status of ALL_STATUSES) {
      const meta = statusMeta(status);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.tone).toBeTruthy();
    }
  });

  it("recognises terminal states", () => {
    expect(isTerminal("COMPLETED")).toBe(true);
    expect(isTerminal("COMPLETED_WITH_WARNINGS")).toBe(true);
    expect(isTerminal("CANCELLED")).toBe(true);
    expect(isTerminal("TESTS_PASSED")).toBe(false);
  });
});
