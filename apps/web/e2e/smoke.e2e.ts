import { expect, test } from "@playwright/test";

const ok = { "200": { description: "ok" } };
const spec = JSON.stringify(
  {
    openapi: "3.0.3",
    info: { title: "Smoke Widgets", version: "1.0.0" },
    servers: [{ url: "https://api.widgets.test" }],
    paths: {
      "/widgets": { get: { operationId: "listWidgets", summary: "List widgets", responses: ok } },
      "/widgets/{id}": {
        get: {
          operationId: "getWidget",
          summary: "Get a widget",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: ok,
        },
      },
    },
  },
  null,
  2,
);

test("styles and web fonts are wired up", async ({ page }) => {
  await page.goto("/login");
  // Next 16's bundler once dropped the fonts' CSS import without a word.
  await expect(page.locator('link[rel="stylesheet"][href^="https://fonts.googleapis.com/"]')).toHaveCount(1);
  // The app's stylesheet applies: the theme's font stacks, not browser defaults.
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^Inter\b/);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector("h2, h1")!).fontFamily)).toMatch(/^Fraunces\b/);
});

test("the sample project shows the recorded usability check and its fixes", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Email").fill(`smoke-sample-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("smoke-test-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects$/);

  await page.getByRole("button", { name: "Try a sample" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Acme Billing (sample)" })).toBeVisible();
  await expect(page.getByText("A sample project")).toBeVisible();
  await expect(page.getByText(/Agents chose the right tool for \d+ of \d+ tasks/)).toBeVisible();
  await expect(page.getByText(/goes with/).first()).toBeVisible();
});

test("sign up, create a project, upload a spec, and get a tool plan", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/login");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Email").fill(`smoke-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("smoke-test-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects$/);

  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("Smoke widgets");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("link", { name: /Smoke widgets/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Smoke widgets" })).toBeVisible();

  await page.getByLabel("OpenAPI specification").fill(spec);
  await page.getByRole("button", { name: "Upload & validate" }).click();
  await expect(page.getByText("Smoke Widgets", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Propose tools" }).click();
  await expect(page.getByText("get_widget", { exact: true })).toBeVisible();
  await expect(page.getByText("list_widgets", { exact: true })).toBeVisible();

  expect(pageErrors).toEqual([]);
});
