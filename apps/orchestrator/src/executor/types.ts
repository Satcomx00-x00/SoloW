/**
 * The `Executor` interface (Foundation 3 of 8 / issue #1). An Executor is where an agent
 * actually runs — the local host today, a container/SSH/cloud driver later (#46 #47 #48). One
 * interface now, before the second implementation exists, means each of those becomes a driver
 * rather than growing its own copy of "how do I reach the place the agent runs".
 *
 * `local.ts` is the only module allowed to call `Bun.spawn`, the Bun shell, or the host
 * filesystem directly — enforced by `scripts/audit-executor-boundary.ts`. Every consumer
 * (the worktree manager, the diff reader, the agent runner) depends on this module only.
 */

/** A long-lived child process, shaped for interactive stream-JSON protocols. */
export interface ProcessHandle {
  stdin: {
    write(data: string): number | Promise<number>;
    flush(): Promise<number>;
    end(): Promise<void>;
  };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  /**
   * End the process, optionally naming the signal. Callers send none for the ordinary stop and
   * escalate to `SIGKILL` only for an agent that ignored it — a driver that cannot route a
   * signal (a container or cloud executor whose API exposes one verb) may ignore the argument.
   */
  kill(signal?: number | string): void;
}

export interface SpawnOpts {
  cwd: string;
  /**
   * Replaces the child's environment; never merged with the executor's own (Principle IV). A
   * subscription run must never let `ANTHROPIC_API_KEY` or any other host variable leak through.
   */
  env: Record<string, string>;
}

export interface ExecOpts {
  cwd?: string;
  /**
   * Extra variables for this one command, merged *over* the executor's own environment.
   *
   * The opposite of `SpawnOpts.env`, and deliberately so. A spawned agent must see exactly what
   * the caller shaped and nothing of the host (Principle IV) — but `exec` runs the product's own
   * short-lived tools, and a `git` that inherited no `PATH`, `HOME` or proxy settings would not
   * run at all. This is the channel for handing git a credential without putting it in argv,
   * where `ps` would show it.
   */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Filesystem access, root-jailed to the Executor's root. Path resolution happens once, here, and
 * every consumer inherits it — this is the highest path-traversal risk surface in the product
 * (#33 file tree, #52 `.env` copy).
 */
export interface ExecutorFs {
  exists(relativePath: string): Promise<boolean>;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  list(relativePath?: string): Promise<string[]>;
  copy(fromRelativePath: string, toRelativePath: string): Promise<void>;
}

export interface ForwardHandle {
  url: string;
  close(): Promise<void>;
}

export interface ExecutorMetrics {
  /** 0-100, or null when it could not be determined. */
  cpuPercent: number | null;
  memPercent: number | null;
  diskPercent: number | null;
  loadAverage: number[];
}

export interface Executor {
  /** A long-lived agent process (e.g. the `claude` CLI in stream-JSON mode). */
  spawn(cmd: string[], opts: SpawnOpts): ProcessHandle;
  /** A one-shot command: git, du, version probes. Never throws on a non-zero exit. */
  exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult>;
  /**
   * The environment a command run by this Executor would otherwise inherit — the host's for the
   * local driver, the image's for a container one. `spawn` replaces the child's environment
   * wholesale (Principle IV), so the *caller* must shape it from the right base: handing a
   * containerised agent the orchestrator's own `PATH` and `HOME` describes a machine it is not
   * running on, and it fails for reasons that have nothing to do with the Task.
   */
  baseEnv(): Promise<Record<string, string>>;
  fs: ExecutorFs;
  /** A dev-server preview (#35). Already reachable for the local executor; a real tunnel for remote ones. */
  forward(port: number): Promise<ForwardHandle>;
  metrics(): Promise<ExecutorMetrics>;
  dispose(): Promise<void>;
}
