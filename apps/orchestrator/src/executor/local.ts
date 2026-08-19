/// <reference types="bun-types" />
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { dirname, resolve, sep } from "node:path";
import type {
  ExecOpts,
  ExecResult,
  Executor,
  ExecutorFs,
  ExecutorMetrics,
  ForwardHandle,
  ProcessHandle,
  SpawnOpts,
} from "./types.js";

/**
 * The local executor (Foundation 3 / issue #1): the execution host is the orchestrator's own
 * machine. This is a **refactor with no behaviour change** — every direct-host call this file
 * makes replaces one that used to live inline in the worktree manager or the agent runner.
 *
 * This is the one module in the orchestrator allowed to touch `Bun.spawn`, `Bun.file`/`Bun.write`,
 * or the host filesystem directly; `scripts/audit-executor-boundary.ts` enforces that everything
 * else reaches the host through the `Executor` it returns.
 */
export function createLocalExecutor(root: string): Executor {
  const jailRoot = resolve(root);

  /** Resolve a path within the jail; throws on any attempt to escape it (AC-2). */
  function resolveJailed(relativePath: string): string {
    const target = resolve(jailRoot, relativePath);
    if (target !== jailRoot && !target.startsWith(jailRoot + sep)) {
      throw new Error(`path escapes executor root: ${relativePath}`);
    }
    return target;
  }

  async function execLocal(cmd: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    const [command, ...args] = cmd;
    if (!command) throw new Error("exec: empty command");
    const proc = Bun.spawn([command, ...args], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  const fs: ExecutorFs = {
    async exists(relativePath) {
      const target = resolveJailed(relativePath);
      try {
        await stat(target);
        return true;
      } catch {
        return false;
      }
    },
    async readFile(relativePath) {
      return readFile(resolveJailed(relativePath), "utf8");
    },
    async writeFile(relativePath, content) {
      const target = resolveJailed(relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },
    async list(relativePath = ".") {
      return readdir(resolveJailed(relativePath));
    },
    async copy(fromRelativePath, toRelativePath) {
      const from = resolveJailed(fromRelativePath);
      const to = resolveJailed(toRelativePath);
      await mkdir(dirname(to), { recursive: true });
      await Bun.write(to, Bun.file(from));
    },
  };

  return {
    spawn(cmd: string[], opts: SpawnOpts): ProcessHandle {
      const proc = Bun.spawn(cmd, {
        cwd: opts.cwd,
        // Replaces the environment rather than extending it: the child sees exactly what the
        // caller shaped, and nothing else of the executor's own process (Principle IV).
        env: opts.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        stdin: {
          write: (data: string) => proc.stdin.write(data),
          flush: () => Promise.resolve(proc.stdin.flush()),
          end: async () => {
            await proc.stdin.end();
          },
        },
        stdout: proc.stdout,
        stderr: proc.stderr,
        exited: proc.exited,
        kill: () => proc.kill(),
      };
    },

    exec: execLocal,

    fs,

    async forward(port: number): Promise<ForwardHandle> {
      // Already local: the port is reachable as-is, no tunnel to build. A remote/container
      // executor is where this grows an actual forward.
      return { url: `http://localhost:${port}`, close: async () => {} };
    },

    async metrics(): Promise<ExecutorMetrics> {
      const load = loadavg();
      const cpuCount = cpus().length || 1;
      const mem = totalmem();
      const free = freemem();

      let diskPercent: number | null = null;
      try {
        const { stdout, exitCode } = await execLocal(["df", "-Pk", jailRoot]);
        if (exitCode === 0) diskPercent = parseDiskPercent(stdout);
      } catch {
        diskPercent = null;
      }

      return {
        // 1-minute load average is not literally CPU%, but with no sampling interval available
        // it is the closest cheap proxy — clamped so a busy host never reports over 100%.
        cpuPercent: Math.min(100, ((load[0] ?? 0) / cpuCount) * 100),
        memPercent: mem > 0 ? ((mem - free) / mem) * 100 : null,
        diskPercent,
        loadAverage: load,
      };
    },

    async dispose(): Promise<void> {
      // The local host outlives every Task run on it; nothing to tear down.
    },
  };
}

/** Parse the `Use%` column from `df -P` output (POSIX format, one header line + one data line). */
function parseDiskPercent(dfOutput: string): number | null {
  const dataLine = dfOutput.trim().split("\n")[1];
  const percent = dataLine?.trim().split(/\s+/)[4];
  if (!percent) return null;
  const value = Number.parseInt(percent.replace("%", ""), 10);
  return Number.isFinite(value) ? value : null;
}
