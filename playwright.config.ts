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
  // The control check (`e2e/control/`) — `make control-check` — is not part of this suite: one
  // long walk down the product's main line per spec, with the same servers and fixture as the
  // rest, run by hand before a commit to main and by CI on every push to main (its own job in
  // verify.yml). Ignored unless that target asks for it.
  testIgnore: process.env["SOLOW_CONTROL_CHECK"] === "1" ? [] : ["**/control/**"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],
  /*
   * One budget, sized from what the suite actually takes.
   *
   * This used to be 60s locally on the theory that a developer machine finishes in "a few
   * seconds" where CI needs 45. That stopped being true and cost an afternoon: measured on an
   * ordinary cloud dev box, the slowest test (the @critical isolation spec, which drives two
   * launch-to-review round trips before it can assert anything) takes 102s, and the first test
   * of a run pays another 15-25s per route for `next dev`'s compile-on-first-visit — 76s just to
   * get one Task to Running. Every happy-path spec failed on the budget rather than on a
   * behaviour, and each reported whichever selector it happened to be waiting on when the clock
   * ran out, which is a different innocent line every run.
   *
   * 180s is the measured worst case plus headroom, not a number chosen to make red go away — the
   * suite was verified green at 240s first, then this was set from the durations that produced.
   * Kept the same for CI and local because the two are no longer meaningfully different, and a
   * split that is not true is worse than no split.
   */
  timeout: 180_000,
  expect: { timeout: 30_000 },
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
      /*
       * A production build, served — the app that ships, not `next dev`.
       *
       * The suite ran on `next dev` and spent its life compensating: a route compiled on its first
       * visit (10–40 s on a loaded host) inside whichever walk got there first, so specs warmed
       * routes in hooks, the server was told to keep what it compiled, and budgets grew around
       * the compiles. Worse than slow, it failed in a way no spec could fix: intermittently, deep in
       * a full run, the server's HTML and the browser's render disagreed about the tree above
       * the shell — React's ids shifted (`radix-_R_5aj9…` served, `_R_1akp…` rendered) — and the
       * hydration error's toast sat over the sidebar's Settings link, while a probe of the same
       * server minutes later saw nothing. Dev-only machinery (Next's segment-explorer wrappers)
       * is the likely cause, not a proven one; a build has neither it nor the compiles.
       *
       * What is given up is dev-only: React's attribute-level hydration diffs and duplicate-key
       * warnings do not print in production. The component tests keep the key checks.
       */
      command: `bunx --bun next build && bunx --bun next start --port ${PORTS.web} --hostname 127.0.0.1`,
      cwd: "apps/web",
      // `/projects` — the app's real front door. The old `/board` readiness URL outlived the
      // route it named: boards moved under `/projects/:id`, the URL began answering 404, and
      // Playwright treats a 404 as "not up yet", so the whole suite timed out before one test
      // ran. Root-adjacent and unparameterised on purpose, so this cannot rot the same way.
      url: `http://127.0.0.1:${PORTS.web}/projects`,
      reuseExistingServer: false,
      // The build: about a minute with Next's cache warm, several cold on a loaded runner.
      timeout: 15 * 60_000,
      env,
    },
  ],
});
