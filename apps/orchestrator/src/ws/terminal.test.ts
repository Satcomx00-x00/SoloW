import { describe, expect, it } from "bun:test";
import { signStreamTicket } from "@solow/core/stream";
import type { Db } from "@solow/db";
import { createLocalExecutor } from "../executor/local.js";
import { authorizeTerminal, terminalCommand, terminalEnv } from "./terminal.js";

const SECRET = "test-stream-secret";
const NOW = 1_800_000_000_000;
// Never reached on the refusal paths: a ticket that names no Task is turned away before any read.
const noDb = {} as Db;
const deps = { db: noDb, now: () => NOW, streamSecret: SECRET };

describe("authorizeTerminal", () => {
  it("refuses an upgrade with no ticket, a forged one, or one that names no Task", async () => {
    expect(await authorizeTerminal("ws://hub/terminal", deps)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(await authorizeTerminal("ws://hub/terminal?ticket=nope.bad", deps)).toMatchObject({
      ok: false,
      status: 401,
    });
    // A board ticket reads the board; it opens no shell.
    const board = signStreamTicket({ workspaceId: "ws-1", taskId: null }, SECRET, NOW);
    expect(
      await authorizeTerminal(`ws://hub/terminal?ticket=${encodeURIComponent(board)}`, deps),
    ).toEqual({ ok: false, status: 403, error: "task_ticket_required" });
  });
});

describe("terminalEnv", () => {
  it("passes who and where through, and nothing the orchestrator keeps secret", () => {
    const env = terminalEnv(
      {
        HOME: "/home/op",
        PATH: "/usr/bin",
        SHELL: "/bin/zsh",
        SOLOW_SECRET_KEY: "k",
        SOLOW_STREAM_SECRET: "s",
        ANTHROPIC_API_KEY: "sk-ant",
        GITHUB_TOKEN: "ghp",
      },
      "task-1",
    );
    expect(env).toEqual({
      HOME: "/home/op",
      PATH: "/usr/bin",
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      SOLOW_TASK_ID: "task-1",
    });
  });

  it("opens the person's own shell as a login shell, bash when none is named", () => {
    expect(terminalCommand({ SHELL: "/bin/zsh" })).toEqual(["/bin/zsh", "-l"]);
    expect(terminalCommand({})).toEqual(["/bin/bash", "-l"]);
  });
});

describe("local executor terminal", () => {
  it("runs a program on a real pseudo-terminal in the given directory, and relays its bytes", async () => {
    const cwd = process.cwd();
    const chunks: Uint8Array[] = [];
    let exitCode = -1;
    const executor = createLocalExecutor(cwd);
    const handle = executor.openTerminal?.(
      ["/bin/sh", "-c", 'if [ -t 0 ]; then echo "tty $(pwd)"; fi; stty size'],
      {
        cwd,
        env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
        cols: 101,
        rows: 33,
        onData: (data) => chunks.push(data),
        onExit: (code) => {
          exitCode = code;
        },
      },
    );
    expect(handle).toBeDefined();
    await handle?.exited;
    // The data callback can trail the exit by a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = new TextDecoder().decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    );
    expect(output).toContain(`tty ${cwd}`);
    expect(output).toContain("33 101");
    expect(exitCode).toBe(0);
  });
});
