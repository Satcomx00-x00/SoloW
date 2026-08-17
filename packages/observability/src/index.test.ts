/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import {
  captureException,
  createLogger,
  logStateTransition,
  logWorktreeBinding,
  withRunContext,
} from "./index.js";

/** Collect NDJSON log lines written by pino for assertions. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line));
      }
      cb();
    },
  });
  return { stream, lines };
}

describe("observability", () => {
  it("binds the service and run-context ids to every line", () => {
    const { stream, lines } = capture();
    const log = withRunContext(createLogger({ service: "orchestrator", destination: stream }), {
      workspaceId: "ws-1",
      taskId: "task-1",
      sessionId: "sess-1",
    });
    log.info("hello");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      service: "orchestrator",
      workspaceId: "ws-1",
      taskId: "task-1",
      sessionId: "sess-1",
      msg: "hello",
    });
  });

  it("emits a state transition with duration (plan §10)", () => {
    const { stream, lines } = capture();
    const log = createLogger({ service: "orchestrator", destination: stream });
    logStateTransition(log, { taskId: "t1", from: "running", to: "review", durationMs: 42 });
    expect(lines[0]).toMatchObject({
      event: "state.transition",
      from: "running",
      to: "review",
      durationMs: 42,
    });
  });

  it("emits the worktree→task audit binding (Principle II)", () => {
    const { stream, lines } = capture();
    const log = createLogger({ service: "orchestrator", destination: stream });
    logWorktreeBinding(log, { workspaceId: "ws-1", taskId: "t1", worktreePath: "/wt/t1" });
    expect(lines[0]).toMatchObject({
      event: "worktree.bound",
      taskId: "t1",
      worktreePath: "/wt/t1",
    });
  });

  it("redacts credential-bearing keys so no secret value is logged (Principle IV)", () => {
    const { stream, lines } = capture();
    const log = createLogger({ service: "orchestrator", destination: stream });
    log.info(
      {
        ciphertext: "iv.tag.data",
        token: "sub-token-abc",
        apiKey: "sk-ant-super-secret",
        env: { ANTHROPIC_API_KEY: "sk-ant-leak", CLAUDE_CODE_OAUTH_TOKEN: "oauth-leak" },
      },
      "run env shaped",
    );
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain("sk-ant-super-secret");
    expect(serialized).not.toContain("sk-ant-leak");
    expect(serialized).not.toContain("oauth-leak");
    expect(serialized).not.toContain("sub-token-abc");
    expect(serialized).toContain("[redacted]");
  });

  it("captureException records the error message at error level", () => {
    const { stream, lines } = capture();
    const log = createLogger({ service: "web", destination: stream });
    captureException(log, new Error("boom"), { taskId: "t1" });
    expect(lines[0]).toMatchObject({ level: 50, taskId: "t1", msg: "boom" });
  });
});
