import { describe, expect, it } from "vitest";
import { jwtSecretFromEnv, MIN_JWT_SECRET_LENGTH } from "../src/auth/jwt.config";

describe("jwtSecretFromEnv", () => {
  it("refuses to run without a secret (no insecure default)", () => {
    expect(() => jwtSecretFromEnv({})).toThrow(/JWT_SECRET is not set/);
    expect(() => jwtSecretFromEnv({ JWT_SECRET: "   " })).toThrow(/JWT_SECRET is not set/);
  });

  it("refuses a secret too short for HS256", () => {
    expect(() => jwtSecretFromEnv({ JWT_SECRET: "dev-secret-change-me" })).toThrow(/at least 32/);
  });

  it("returns a strong enough secret", () => {
    const secret = "a".repeat(MIN_JWT_SECRET_LENGTH);
    expect(jwtSecretFromEnv({ JWT_SECRET: secret })).toBe(secret);
  });
});
