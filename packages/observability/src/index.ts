import {
  type Level,
  type LevelWithSilent,
  type Logger,
  type LoggerOptions as PinoLoggerOptions,
  pino,
} from "pino";

/**
 * Observability (task TASK-027 / plan §10). Structured logs carry the tenant/task/session
 * ids and state transitions; `captureException` records errors at boundaries. Secret values
 * MUST never reach a log — known credential-bearing keys are redacted here as a backstop, and
 * callers must not pass raw secret values in the first place (Principle IV).
 */

export type { Logger };

/** Fields that may carry a credential; redacted wherever they appear (backstop, not a license). */
const REDACT_PATHS = [
  "ciphertext",
  "*.ciphertext",
  "secret",
  "*.secret",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "value",
  "*.value",
  "env.ANTHROPIC_API_KEY",
  "env.CLAUDE_CODE_OAUTH_TOKEN",
  "*.env.ANTHROPIC_API_KEY",
  "*.env.CLAUDE_CODE_OAUTH_TOKEN",
];

export interface LoggerOptions {
  /** Service name bound to every line, e.g. "web" or "orchestrator". */
  service: string;
  level?: LevelWithSilent;
  /** Test hook: write NDJSON lines here instead of stdout. */
  destination?: NodeJS.WritableStream;
}

/** Create the root logger for a service. */
export function createLogger(opts: LoggerOptions): Logger {
  const base = { service: opts.service };
  const options: PinoLoggerOptions = {
    level: opts.level ?? (process.env.LOG_LEVEL as Level | undefined) ?? "info",
    base,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

/** Correlation fields threaded through a run (plan §10). */
export interface RunContext {
  workspaceId?: string;
  taskId?: string;
  sessionId?: string;
}

/** Child logger bound to a run's correlation ids. */
export function withRunContext(logger: Logger, ctx: RunContext): Logger {
  return logger.child(ctx);
}

/** Emit a Task/Session state transition with its duration (plan §10 signal). */
export function logStateTransition(
  logger: Logger,
  args: RunContext & { from: string; to: string; durationMs?: number },
): void {
  logger.info(
    { event: "state.transition", from: args.from, to: args.to, durationMs: args.durationMs },
    `state ${args.from} → ${args.to}`,
  );
}

/** Audit line binding a worktree path to a task id (isolation audit, plan §10 / Principle II). */
export function logWorktreeBinding(
  logger: Logger,
  args: { workspaceId: string; taskId: string; worktreePath: string },
): void {
  logger.info(
    { event: "worktree.bound", worktreePath: args.worktreePath, taskId: args.taskId },
    "worktree bound to task",
  );
}

/** Record an error at a boundary. Never pass secret material in `context`. */
export function captureException(
  logger: Logger,
  error: unknown,
  context?: Record<string, unknown>,
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error({ err, ...context }, err.message);
}

/** Time an async step and emit a `durationMs` span-like log. */
export async function withTiming<T>(
  logger: Logger,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    logger.info({ span: name, durationMs: Math.round(performance.now() - start) }, name);
    return result;
  } catch (error) {
    logger.error(
      { span: name, durationMs: Math.round(performance.now() - start) },
      `${name} failed`,
    );
    throw error;
  }
}
