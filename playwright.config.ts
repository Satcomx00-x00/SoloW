import { defineConfig } from "@playwright/test";
import { E2E_ENV, PORTS, prepareFixture } from "./e2e/support/fixture.js";

/**
 * E2E configuration (tasks TASK-025 / TASK-026).
 *
 * The fixture is built here, at config load, so it is guaranteed to exist before either server
 * starts — Playwright launches `webServer` entries in parallel, so ordering cannot be expressed
 * through `globalSetup`. Tests run serially against one shared database: the isolation spec
 * launches concurrent Tasks on purpose, and a parallel worker would make "concurrent" ambiguous.
 */
prepareFixture();

const env = { ...process.env, ...E2E_ENV } as Record<string, string>;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],
  // CI runners are markedly slower than a development machine: a single launch-to-review
  // round trip measures ~45s there against a few seconds locally, and the @critical
  // isolation spec performs two of them inside one test before it can assert anything.
  // The budget is raised for CI only — no assertion is weakened, the suite is simply
  // allowed the wall-clock the hardware needs.
  timeout: process.env["CI"] ? 180_000 : 60_000,
  expect: { timeout: process.env["CI"] ? 30_000 : 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORTS.web}`,
    trace: "retain-on-failure",
    // Selector-based waits only — no fixed sleeps anywhere in the suite.
    actionTimeout: 15_000,
  },
  webServer: [
    {
      command: "bun run e2e/support/orchestrator.ts",
      url: `http://127.0.0.1:${PORTS.orchestrator}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env,
    },
    {
      command: `bunx --bun next dev --port ${PORTS.web} --hostname 127.0.0.1`,
      cwd: "apps/web",
      // `/projects` — the app's real front door. The old `/board` readiness URL outlived the
      // route it named: boards moved under `/projects/:id`, the URL began answering 404, and
      // Playwright treats a 404 as "not up yet", so the whole suite timed out before one test
      // ran. Root-adjacent and unparameterised on purpose, so this cannot rot the same way.
      url: `http://127.0.0.1:${PORTS.web}/projects`,
      reuseExistingServer: false,
      timeout: 180_000,
      env,
    },
  ],
});
