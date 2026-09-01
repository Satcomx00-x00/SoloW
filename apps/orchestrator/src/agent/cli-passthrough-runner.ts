import { detectFailureSignal, type FailureSignal } from "@solow/core";
import type { Executor, ProcessHandle } from "../executor/types.js";
import type {
  AgentHandle,
  AgentOutcome,
  AgentRunner,
  AgentStartOpts,
  AgentTextChannel,
} from "./runner.js";

/**
 * Any CLI at all, as an agent (issue #21).
 *
 * The third protocol was named in the enum long before it had a driver, and until now a Task
 * pointed at it was failed before it started. That made "adding an agent is a data row" true
 * only for agents that already speak one of two protocols — which is most of them, but not the
 * long tail, and the long tail is the reason the catalog is data in the first place.
 *
 * **What it is.** The brief is handed to the command as its final argument, the command's stdout
 * is the transcript, and its exit status is the outcome. That is the whole contract. There is no
 * handshake to negotiate, no tool vocabulary to map, and nothing to pin — which is exactly why
 * it works for a CLI nobody wrote an adapter for.
 *
 * **What it deliberately is not.** No tool calls, no permission requests, no usage. A passthrough
 * agent's output arrives as assistant text and nothing else, because inventing structure from an
 * arbitrary CLI's stdout would be guessing — and a transcript that says a tool ran when the
 * runner merely saw a line that looked like one is worse than a plain transcript. The Owner is
 * told this before choosing (`AGENT_PROTOCOLS.cli_passthrough.hint`).
 *
 * The isolation guarantee is unchanged: the lifecycle provisions the worktree and passes it as
 * `cwd`, exactly as it does for ACP (Principle II).
 */

export interface CliPassthroughRunnerOptions {
  /** Where the process actually runs — issue #1's `Executor`. */
  executor: Executor;
}

/**
 * How the brief reaches the command.
 *
 * As the last argument, not on stdin: a CLI agent invoked as `agent "do the thing"` is the
 * overwhelmingly common shape, and the ones that read a prompt from stdin generally also accept
 * it as an argument. stdin stays open for operator steering instead, which is the only way this
 * runner can offer `send` at all.
 */
function commandLine(opts: AgentStartOpts): string[] {
  return [opts.command, ...opts.args, opts.prompt];
}

/** Decode a byte stream into whole-ish chunks, emitting each as it arrives. */
async function pump(
  stream: AsyncIterable<Uint8Array>,
  onText: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) onText(text);
  }
  const rest = decoder.decode();
  if (rest) onText(rest);
}

/**
 * How long the pipes get to finish once the command itself has exited.
 *
 * Generous by the standard of what it is waiting for — a drain that has anything left to do
 * finishes in single-digit milliseconds — because the only cost of waiting is a stop that takes
 * a moment longer, and the cost of cutting it short is a truncated transcript.
 */
const DRAIN_GRACE_MS = 2_000;

/**
 * Wait for the output to drain, but never indefinitely.
 *
 * The wait is not optional — the last lines of a short-lived command arrive *after* `exited`
 * resolves, and answering before them truncates the transcript the answer is about. But it
 * cannot be unbounded either, and the reason is a process this runner cannot see: a command is
 * free to fork, and a fork inherits the same stdout and stderr pipes. Kill the command and the
 * child lives on holding the write end open, so the read end never reaches EOF and a drain that
 * waits for one waits for the orphan — `stop()` blocking behind a process it has already killed,
 * for as long as that process happens to live.
 *
 * That is not hypothetical: `sh -c 'sleep 30'` reproduces it exactly, because `sh` forks `sleep`
 * rather than exec'ing it, and the runner's own "a stop is an ended run" test hung on it for
 * ten seconds at a time until this bound existed.
 */
function drained(streams: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, DRAIN_GRACE_MS);
    // Nothing should stay alive merely because a grace period is still counting down.
    (timer as { unref?: () => void }).unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    streams.then(done, done);
  });
}

export class CliPassthroughRunner implements AgentRunner {
  constructor(private readonly options: CliPassthroughRunnerOptions) {}

  start(opts: AgentStartOpts): AgentHandle {
    const proc: ProcessHandle = this.options.executor.spawn(commandLine(opts), {
      cwd: opts.cwd,
      env: opts.env,
    });

    /**
     * Kept for the failure signal only, and bounded.
     *
     * A CLI that fails usually says why on stderr, and that sentence is what turns a bare exit
     * code into something an operator can act on. It is not streamed into the transcript as
     * assistant text: stderr is where progress bars and warnings go too, and a transcript that
     * interleaved them with the agent's answer would be unreadable.
     */
    let stderrTail = "";
    const noteStderr = (text: string) => {
      stderrTail = `${stderrTail}${text}`.slice(-4_000);
    };

    /*
     * Latched once the outcome is decided. Only the bounded drain below can make it matter: an
     * orphaned child still holding the pipe can produce output after this run has been answered
     * for, and a transcript that grows after the run it belongs to has completed describes
     * something the reviewer is no longer looking at.
     */
    let answered = false;

    const emit = (channel: AgentTextChannel, text: string) => {
      if (answered) return;
      opts.onEvent({ kind: "stdout", channel, text });
    };

    const streams = Promise.all([
      pump(proc.stdout, (text) => emit("assistant", text)),
      pump(proc.stderr, noteStderr),
    ]);

    let stopped = false;

    const outcome: Promise<AgentOutcome> = (async () => {
      const code = await proc.exited;
      // Drained before answering: the last lines of a short-lived command arrive after `exited`
      // resolves, and an outcome reported before them would truncate the transcript it is about.
      // Bounded, because a forked child can hold those pipes open long after the command is gone
      // — see `drained`.
      await drained(streams);
      answered = true;

      if (code === 0) return { kind: "completed" };
      /*
       * A stop is not a failure. The operator ended the run deliberately, and whatever the
       * process exited with on the way out describes how it was ended, not what it did — the
       * same rule both other runners follow so partial work still reaches review.
       */
      if (stopped) return { kind: "completed" };

      /*
       * stderr is the only evidence a plain CLI gives about *why* it failed, so it is what the
       * quota/credential classification reads — the same `detectFailureSignal` both other runners
       * use, which answers an empty signal when it recognises nothing. An unrecognised failure
       * stays a plain failure rather than being guessed at.
       */
      const signal: FailureSignal = detectFailureSignal(stderrTail);
      return { kind: "failed", signal };
    })();

    return {
      outcome,
      // SoloW provisioned the worktree and passed it as `cwd`; there is nothing to adopt.
      workspacePath: Promise.resolve(opts.cwd),
      async send(text: string) {
        if (stopped) return false;
        try {
          await proc.stdin.write(`${text}\n`);
          await proc.stdin.flush();
          return true;
        } catch {
          // A CLI that closed its stdin, or never read one, is not steerable — reported as a
          // refusal so the terminal can say so rather than appearing to have delivered it.
          return false;
        }
      },
      async stop() {
        stopped = true;
        try {
          await proc.stdin.end();
        } catch {
          // Already gone; the kill below is what actually ends it.
        }
        proc.kill();
        await outcome.catch(() => undefined);
      },
    };
  }
}
