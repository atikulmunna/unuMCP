import { describe, expect, it } from "vitest";
import { statusesFor } from "../src/testing/test-results";

describe("statusesFor", () => {
  it("marks a passing run passed everywhere", () => {
    expect(statusesFor({ passed: true, infraFailed: false })).toEqual({
      test: "passed",
      project: "TESTS_PASSED",
      run: "passed",
    });
  });

  it("marks a clean test failure as failed tests, the case repair works on", () => {
    expect(statusesFor({ passed: false, infraFailed: false })).toEqual({
      test: "failed",
      project: "TESTS_FAILED",
      run: "failed",
    });
  });

  it("keeps an infrastructure failure apart from a test failure", () => {
    expect(statusesFor({ passed: false, infraFailed: true })).toEqual({
      test: "errored",
      project: "SANDBOX_FAILED",
      run: "failed",
    });
  });
});
