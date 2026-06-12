import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact";

describe("redactSecrets", () => {
  it("redacts known token shapes", () => {
    const cases = [
      "fetched with ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "key AKIAIOSFODNN7EXAMPLE used",
      "slack xoxb-1234567890-abcdefghij here",
      "openai sk-abcdefghijklmnopqrstuvwxyz0123 done",
      "google AIzaSyA1234567890abcdefghijklmnopqrstuv now",
    ];
    for (const text of cases) {
      const out = redactSecrets(text);
      expect(out, text).toContain("***REDACTED***");
    }
    // None of the original secret material survives.
    expect(redactSecrets("ghp_0123456789abcdefghijklmnopqrstuvwxyz")).not.toContain("ghp_0123");
  });

  it("redacts a private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj\nabcDEF\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(`config:\n${pem}\ndone`);
    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain("MIIBOgIBAAJBAKj");
    expect(out).toContain("done");
  });

  it("redacts authorization header values", () => {
    const out = redactSecrets('Authorization: Bearer abc123def456ghi789');
    expect(out).toContain("Authorization");
    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain("abc123def456ghi789");
  });

  it("redacts secret-named key/value pairs", () => {
    expect(redactSecrets("api_key=supersecretvalue123")).toBe("api_key=***REDACTED***");
    expect(redactSecrets('{"password": "hunter2hunter2"}')).toContain("***REDACTED***");
    expect(redactSecrets('{"password": "hunter2hunter2"}')).not.toContain("hunter2hunter2");
  });

  it("leaves placeholders, env refs, and ordinary text legible", () => {
    expect(redactSecrets("API_KEY=your_token_here")).toBe("API_KEY=your_token_here");
    expect(redactSecrets("apiKey: process.env.TOKEN")).toBe("apiKey: process.env.TOKEN");
    expect(redactSecrets("Tests 4 passed (4)")).toBe("Tests 4 passed (4)");
    expect(redactSecrets("added 50 packages")).toBe("added 50 packages");
  });

  it("handles empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});
