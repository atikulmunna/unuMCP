import { describe, expect, it } from "vitest";
import {
  ArgumentsHost,
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";

// A leaked GitHub token shape — must never reach the client (NFR-001 / §17.2).
const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

interface Captured {
  status: number;
  body: any;
}

/** Minimal ArgumentsHost whose response captures what the filter writes. */
function run(exception: unknown, url = "/projects/x/generation"): Captured {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: "POST", url }),
    }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);
  return captured;
}

describe("AllExceptionsFilter (P6-8, §17)", () => {
  it("preserves an actionable 4xx message and wraps it in the envelope", () => {
    const { status, body } = run(new BadRequestException("Approve at least one tool before generating."));
    expect(status).toBe(400);
    expect(body.statusCode).toBe(400);
    expect(body.error).toBe("Bad Request");
    expect(body.message).toBe("Approve at least one tool before generating.");
    expect(body.path).toBe("/projects/x/generation");
    expect(typeof body.correlationId).toBe("string");
    expect(body.correlationId.length).toBeGreaterThan(0);
    expect(typeof body.timestamp).toBe("string");
  });

  it("redacts a secret echoed back in a 4xx message", () => {
    const { body } = run(new BadRequestException(`Spec referenced ${TOKEN} in a server URL.`));
    expect(body.message).not.toContain(TOKEN);
    expect(body.message).toContain("***REDACTED***");
  });

  it("never leaks an unexpected error's message or stack on a 500", () => {
    const { status, body } = run(new Error(`boom with secret ${TOKEN} in it`));
    expect(status).toBe(500);
    expect(body.error).toBe("Internal Server Error");
    expect(body.message).not.toContain(TOKEN);
    expect(body.message).not.toContain("boom");
    // Generic but actionable, and traceable via the correlationId.
    expect(body.message).toMatch(/unexpected error/i);
    expect(body.message).toContain(body.correlationId);
  });

  it("redacts a secret hidden in an explicit InternalServerErrorException too", () => {
    const { status, body } = run(new InternalServerErrorException(`failed: ${TOKEN}`));
    expect(status).toBe(500);
    expect(body.message).not.toContain(TOKEN);
    expect(body.message).toMatch(/unexpected error/i);
  });

  it("preserves structured validation details (errors[]) for invalid input", () => {
    const { body } = run(
      new BadRequestException({
        message: "Invalid OpenAPI specification",
        errors: ["missing `paths` section"],
      }),
    );
    expect(body.message).toBe("Invalid OpenAPI specification");
    expect(JSON.stringify(body.errors)).toContain("paths");
  });

  it("carries the Zod flatten shape through as errors", () => {
    const { body } = run(
      new BadRequestException({
        formErrors: [],
        fieldErrors: { email: ["Invalid email"] },
      }),
    );
    expect(JSON.stringify(body.errors)).toContain("Invalid email");
  });
});
