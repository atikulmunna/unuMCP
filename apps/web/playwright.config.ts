import { defineConfig, devices } from "@playwright/test";

// Browser smoke test: a production build of the web app against the real API
// and database, for what unit tests can't see (pages render, styles and web
// fonts are wired up, the main flow works end to end). Its own ports, so it
// never collides with a dev server.
const API_PORT = 3101;
const WEB_PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${WEB_PORT}`, trace: "retain-on-failure" },
  webServer: [
    {
      // The compiled API, as production runs it (built with its packages first).
      command: "pnpm exec turbo run build --filter=@unumcp/api... && node -C unumcp-dist dist/main.js",
      cwd: "../api",
      // 401 means the API is up.
      url: `http://localhost:${API_PORT}/api/auth/me`,
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unumcp:unumcp@localhost:5433/unumcp?schema=public",
        JWT_SECRET: "unumcp-e2e-only-jwt-secret-0123456789abcdef",
        LLM_DISABLED: "true",
        JOBS_INLINE: "true",
      },
    },
    {
      // Next bakes the /api rewrite target into the build, so build for this API.
      command: `node node_modules/next/dist/bin/next build && node node_modules/next/dist/bin/next start -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/login`,
      timeout: 300_000,
      env: { API_URL: `http://localhost:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
});
