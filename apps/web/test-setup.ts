import { mock } from "bun:test";

// The DAL modules import "server-only" (a Next.js marker that throws outside a Server
// Component). Under the bun test runner there is no react-server condition, so stub it
// out to an empty module. This only affects the test process.
mock.module("server-only", () => ({}));
