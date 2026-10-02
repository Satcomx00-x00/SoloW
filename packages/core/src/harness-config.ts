import {
  err,
  HARNESS_CONFIG_TARGETS,
  type HarnessConfigContent,
  type HarnessConfigHarness,
  harnessConfigViolations,
  ok,
  type Result,
} from "@solow/contracts";

/** What a Harness Config adds to one launch (Decision 0028). */
export interface HarnessConfigLaunch {
  /** Variables applied with the app-owned configuration env, above any Executor Profile's. */
  env: Record<string, string>;
  /** Claude Code `--settings`, merged under the app's own (checkpoint hooks); null for none. */
  settings: Record<string, unknown> | null;
}

export const NO_HARNESS_CONFIG: HarnessConfigLaunch = { env: {}, settings: null };

/**
 * Turn a stored config into what the launch carries, or refuse it.
 *
 * Re-checked here although every write was checked: the catalog row's own credential variables
 * (`reserved`) are only known at launch, and a row written before a rule existed must not slip
 * past it. A refusal names every key so the operator can fix the config rather than guess.
 */
export function resolveHarnessConfigLaunch(
  config: { harness: HarnessConfigHarness; content: HarnessConfigContent } | null,
  runsOn: HarnessConfigHarness | null,
  reserved: readonly string[],
): Result<HarnessConfigLaunch, string> {
  if (!config) return ok(NO_HARNESS_CONFIG);
  if (config.harness !== runsOn) {
    return err(
      `it is written for ${HARNESS_CONFIG_TARGETS[config.harness].label}, not this harness`,
    );
  }
  const violations = harnessConfigViolations(config.harness, config.content, reserved);
  if (violations.length > 0) return err(violations.join("; "));

  const { delivery } = HARNESS_CONFIG_TARGETS[config.harness];
  return ok(
    delivery.kind === "env"
      ? { env: { [delivery.name]: JSON.stringify(config.content) }, settings: null }
      : { env: {}, settings: { ...config.content } },
  );
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep-merge `app` over `user`: objects recurse, arrays concatenate, the app's scalar wins.
 *
 * Concatenation is what keeps both sides' hooks: a checkpoint's `PreToolUse` entry is appended to
 * the operator's own rather than replacing them — and an operator's config can never displace it.
 */
export function mergeHarnessSettings(
  user: Readonly<Record<string, unknown>>,
  app: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...user };
  for (const [key, value] of Object.entries(app)) {
    const mine = out[key];
    out[key] =
      isPlainObject(mine) && isPlainObject(value)
        ? mergeHarnessSettings(mine, value)
        : Array.isArray(mine) && Array.isArray(value)
          ? [...mine, ...value]
          : value;
  }
  return out;
}
