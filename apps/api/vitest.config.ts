import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["reflect-metadata"],
    // NestJS app bootstrap + DB hits; keep generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://unumcp:unumcp@localhost:5433/unumcp?schema=public",
      JWT_SECRET: process.env.JWT_SECRET ?? "test-secret",
      // Off for the suite (many registrations share one IP); the limiter's own
      // dedicated tests construct the guard with an explicit enabled config.
      RATE_LIMIT_DISABLED: "true",
      // Never make a billed LLM call from the suite; propose falls back to the
      // deterministic description. LlmService unit tests inject a fake client.
      LLM_DISABLED: "true",
      // Run jobs inline (no Redis) so the suite needs no broker; the dedicated
      // queue integration test sets REDIS_URL to opt into the BullMQ path.
      JOBS_INLINE: "true",
    },
  },
  plugins: [
    // SWC transpiles decorators *with metadata* (esbuild cannot), which NestJS DI requires.
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2022",
      },
    }),
  ],
});
