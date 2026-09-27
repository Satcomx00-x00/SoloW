import { z } from "zod";
import { idSchema } from "./common.js";

/**
 * Executor Profile configuration (issue #73, spec F07).
 *
 * One typed payload per Executor kind, expressed as a **discriminated union** and stored in a
 * single JSON column. The alternative — a column per kind, or a table per kind — makes every new
 * runtime a schema migration plus a DAL change plus a form rewrite. Here a new runtime is a
 * member added below plus a driver: the executor matrix (#96 Docker, #97 SSH, #107 Kubernetes)
 * becomes additive rather than schema-breaking.
 *
 * Two rules hold across every member, and both are enforced by the shapes themselves rather
 * than by review:
 *
 * 1. **Credentials are secret references, never inline values** (Principle IV). No member has a
 *    field for a key, password, or token — only an id pointing at the encrypted `secret` table.
 *    Members are `.strict()`, so a config carrying `privateKey` is *rejected* at the boundary
 *    rather than silently stripped and forgotten about.
 * 2. **A profile's environment is for the runtime, not for the harness's credential.** The
 *    variables the billing guard owns cannot be set here at all — see `GUARDED_ENV_VARS`.
 */

/** POSIX environment-variable name. */
const envVarName = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "environment variable names must match [A-Za-z_][A-Za-z0-9_]*",
  );

/**
 * The variables the billing guard shapes (Principle IV). A profile that could set either of
 * these would be a back door around subscription/API-key billing integrity, so they are refused
 * at the API boundary — loudly, rather than accepted and then quietly overridden downstream.
 */
export const GUARDED_ENV_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export function isGuardedEnvVar(name: string): boolean {
  return (GUARDED_ENV_VARS as readonly string[]).includes(name);
}

/**
 * The variables that tell a harness *where its configuration lives* (Decision 0027).
 *
 * A Task's harness runs against a blank, app-owned configuration: `$HOME` is a directory SoloW
 * made for that Task, so `~/.claude/`, `~/.claude.json`, `$HOME/CLAUDE.md`, the operator's
 * `settings.json`, their user-level MCP servers and their user-level Skills are all somewhere the
 * harness never looks. Repository-level configuration — a `CLAUDE.md` or `.claude/` committed in
 * the checkout — is the *project's* and is untouched. `CLAUDE_CONFIG_DIR` is named explicitly
 * because Claude Code honours it over `$HOME` (verified against 2.1.280: with it set, `.claude.json`
 * is written inside it and not in `$HOME`), so pointing `HOME` alone would leave that door open.
 *
 * **Deliberately NOT in `GUARDED_ENV_VARS`, and this is the point of keeping two lists.** That
 * constant feeds the `.refine` below, which *rejects* the whole profile; adding these names there
 * would turn every Executor Profile that has ever set `HOME` into a validation error — a breaking
 * API change, to stop something that is merely futile rather than dangerous. A profile may say
 * `HOME`; `resolveHarnessRunEnv` silently drops it, because the app's answer is applied after the
 * profile's and must win.
 */
export const HARNESS_CONFIG_ENV_VARS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "CLAUDE_CONFIG_DIR",
] as const;

export function isHarnessConfigEnvVar(name: string): boolean {
  return (HARNESS_CONFIG_ENV_VARS as readonly string[]).includes(name);
}

const envMap = z
  .record(envVarName, z.string())
  .refine((env) => !Object.keys(env).some(isGuardedEnvVar), {
    message: `a profile may not set ${GUARDED_ENV_VARS.join(" or ")} — the billing guard owns those (Principle IV)`,
  })
  .default({});

/** A shell snippet run in the workspace before the harness starts. */
const prepareScript = z.string().max(20_000).optional();

const localConfig = z
  .object({
    kind: z.literal("local"),
    prepareScript,
    env: envMap,
  })
  .strict();

const dockerMount = z
  .object({
    /** Path on the host holding the container. */
    source: z.string().min(1),
    /** Absolute path inside the container. */
    target: z.string().startsWith("/"),
    readOnly: z.boolean().default(false),
  })
  .strict();

const dockerConfig = z
  .object({
    kind: z.literal("docker"),
    image: z.string().min(1),
    mounts: z.array(dockerMount).max(32).default([]),
    /** Docker network name, or omitted for the daemon's default. */
    network: z.string().min(1).optional(),
    /** Fractional host CPUs (`--cpus`). Omitted means the daemon's default: no quota. */
    cpus: z.number().positive().max(1024).optional(),
    /** Hard memory ceiling in MiB (`--memory`). 6 is the daemon's own floor. */
    memoryMb: z.number().int().min(6).optional(),
    prepareScript,
    env: envMap,
  })
  .strict();

const sshConfig = z
  .object({
    kind: z.literal("ssh"),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535).default(22),
    user: z.string().min(1),
    /** Reference to the encrypted private key. The key itself never lives here (AC-3). */
    keySecretId: idSchema,
    prepareScript,
    env: envMap,
  })
  .strict();

const cloudConfig = z
  .object({
    kind: z.literal("cloud"),
    provider: z.string().min(1),
    region: z.string().min(1).optional(),
    size: z.string().min(1),
    /** Reference to the encrypted provider credential (AC-3). */
    credentialSecretId: idSchema,
    prepareScript,
    env: envMap,
  })
  .strict();

export const executorConfigSchema = z.discriminatedUnion("kind", [
  localConfig,
  dockerConfig,
  sshConfig,
  cloudConfig,
]);
export type ExecutorConfig = z.infer<typeof executorConfigSchema>;

/**
 * Executor kinds. Kept beside the union deliberately: the two must name the same set, and
 * `executor-config.test.ts` asserts it, so adding a member without widening the enum fails a
 * test rather than shipping a kind nothing can select.
 */
export const executorKindSchema = z.enum(["local", "docker", "ssh", "cloud"]);
export type ExecutorKind = z.infer<typeof executorKindSchema>;

/** The configuration a profile gets when the caller states a kind and nothing else. */
export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = { kind: "local", env: {} };
