/// <reference types="bun-types" />

/**
 * A scripted stand-in for the `claude` binary.
 *
 * It speaks the real stream-JSON protocol on stdout and reads real stream-JSON turns on stdin,
 * so a test exercises the actual parsing, framing and turn-taking rather than a stub of them.
 * The real CLI needs credentials and a model; this needs neither, which is what makes the run
 * loop testable at all.
 */
export interface FakeClaudeTurn {
  /** Assistant text emitted for this turn. */
  text?: string[];
  /** Tool names announced for this turn. */
  tools?: string[];
  /** Files (relative to the reported worktree) written during this turn. */
  writes?: Array<{ path: string; content: string }>;
}

export interface FakeClaudeScript {
  /** The directory to report as the session's cwd, standing in for `--worktree`'s creation. */
  cwd?: string;
  turns?: FakeClaudeTurn[];
  /** Ends the run with `is_error: true` and this subtype. */
  failWith?: string;
  /** Written to stderr before anything else, for failure-classification tests. */
  stderr?: string;
  /** Exit without ever emitting a `result` event. */
  dieEarly?: boolean;
}

const emit = (event: unknown) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

/** Run the fake CLI on this process's stdio, following `script`. */
export async function serveFakeClaude(script: FakeClaudeScript): Promise<void> {
  if (script.stderr) process.stderr.write(script.stderr);

  const cwd = script.cwd ?? process.cwd();
  emit({ type: "system", subtype: "init", cwd, session_id: "fake-session", model: "fake-model" });

  if (script.dieEarly) return;

  const turns = script.turns ?? [{ text: ["ok"] }];
  let index = 0;

  // One scripted turn per user turn on stdin. The first arrives immediately (the opening
  // prompt); later ones are the operator steering the run.
  for await (const line of console) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const turn = turns[index++] ?? { text: ["ok"] };
    // Faithful to the real CLI in the detail that matters for usage: ONE assistant message,
    // split across several stream events (one per content block), with the whole turn's usage
    // repeated on every one. A consumer that sums per event over-counts; the fake has to show
    // that, or the tests cannot see it.
    const messageId = `msg_${index}`;
    const usage = {
      input_tokens: 100 * index,
      output_tokens: 10 * index,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 1,
    };
    const message = (content: unknown) => ({
      type: "assistant",
      message: { id: messageId, model: "test-model", content: [content], usage },
    });

    for (const tool of turn.tools ?? []) {
      emit(message({ type: "tool_use", id: `t-${tool}`, name: tool, input: {} }));
    }
    for (const write of turn.writes ?? []) {
      await Bun.write(`${cwd}/${write.path}`, write.content);
    }
    for (const text of turn.text ?? []) {
      emit(message({ type: "text", text }));
    }

    // The run ends when the script runs out of turns; anything left keeps the session open so
    // a test can send another turn into it.
    if (index >= turns.length) {
      emit(
        script.failWith
          ? { type: "result", subtype: script.failWith, is_error: true, session_id: "fake-session" }
          : {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "done",
              session_id: "fake-session",
            },
      );
      return;
    }
  }
}

/** Path to the runnable fake, for tests and fixtures that need to *spawn* a `claude`. */
export const FAKE_CLAUDE_MAIN = new URL("./fixtures/claude-main.ts", import.meta.url).pathname;

/**
 * Write an executable that stands in for the `claude` binary at `dir/claude`.
 *
 * SoloW puts its own flags first (`--print`, `--worktree`, …), so the fake cannot simply
 * be `bun run fixture.ts` — bun would try to interpret those as its own. A tiny shim swallows
 * the argument list and forwards it to the fixture, which picks out the JSON script and ignores
 * everything else. Returns the path to use as the agent command.
 */
export async function writeFakeClaudeBin(dir: string, script: FakeClaudeScript): Promise<string> {
  const binPath = `${dir}/claude`;
  await Bun.write(
    binPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(FAKE_CLAUDE_MAIN)} ${JSON.stringify(
      JSON.stringify(script),
    )} "$@"\n`,
  );
  await Bun.$`chmod +x ${binPath}`.quiet();
  return binPath;
}
