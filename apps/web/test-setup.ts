import { mock } from "bun:test";

// The DAL modules import "server-only" (a Next.js marker that throws outside a Server
// Component). Under the bun test runner there is no react-server condition, so stub it
// out to an empty module. This only affects the test process.
mock.module("server-only", () => ({}));

/*
 * The web env every server test runs under, set once, here, before any test file loads.
 *
 * It used to be set per file with `??=`, and the values disagreed: the router tests wrote a
 * 16-character `SOLOW_AUTH_SECRET`, the auth tests a 32-character one, and `webEnv()` requires 32.
 * Whichever file ran first won for the whole process — so the suite passed where the auth tests
 * happened to sort first (every laptop) and 20 tests failed where they did not (CI, since
 * 2026-09-16). Assigned rather than `??=` so a value exported in someone's shell cannot change
 * what the tests see either.
 */
const TEST_ENV = {
  SOLOW_AUTH_SECRET: "test-auth-secret-at-least-32-characters",
  SOLOW_STREAM_SECRET: "test-stream-secret",
  SOLOW_WEB_URL: "http://localhost:5000",
  SOLOW_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
} as const;
for (const [name, value] of Object.entries(TEST_ENV)) process.env[name] = value;
