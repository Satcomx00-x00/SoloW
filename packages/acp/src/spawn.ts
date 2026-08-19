/// <reference types="bun-types" />
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

/**
 * Process transport for an ACP agent (task TASK-014). ACP over stdio is newline-delimited
 * JSON-RPC on the child's stdin/stdout, which `ndJsonStream` handles; this module's job is to
 * start the process and hand back its streams.
 *
 * Credential isolation (Principle IV): `env` *replaces* the environment rather than extending
 * it, so the child sees exactly what the billing guard shaped — the one credential for its auth
 * mode and nothing else from the orchestrator's own environment.
 */

export interface SpawnAcpAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Agent diagnostics: stderr is not protocol traffic, so it is surfaced separately. */
  onStderr?: (text: string) => void;
}

export interface SpawnedAgent {
  stream: Stream;
  pid: number;
  /** Resolves with the exit code once the process has ended. */
  exited: Promise<number>;
  /**
   * Resolves once every byte of stderr has been handed to `onStderr`. A caller classifying a
   * failure must await this: an agent that dies immediately loses the race with its own error
   * message otherwise, and a quota exhaustion would be misread as a hard failure.
   */
  stderrDrained: Promise<void>;
  /** Terminate the process and wait for it to be gone. */
  kill(): Promise<number>;
}

export function spawnAcpAgent(options: SpawnAcpAgentOptions): SpawnedAgent {
  const proc = Bun.spawn([options.command, ...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const onStderr = options.onStderr;
  const stderrDrained = onStderr
    ? (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stderr) onStderr(decoder.decode(chunk));
      })()
    : Promise.resolve();

  return {
    stream: ndJsonStream(sinkToWritable(proc.stdin), proc.stdout),
    pid: proc.pid,
    exited: proc.exited,
    stderrDrained,
    async kill() {
      proc.kill();
      return proc.exited;
    },
  };
}

/** Adapt Bun's `FileSink` stdin to the `WritableStream` the ACP stream helper expects. */
function sinkToWritable(sink: Bun.FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk);
      await sink.flush();
    },
    close() {
      // The child reads EOF and shuts down its side of the protocol.
      void sink.end();
    },
    abort() {
      void sink.end();
    },
  });
}
