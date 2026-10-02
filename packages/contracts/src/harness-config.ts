import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";
import { GUARDED_ENV_VARS, HARNESS_CONFIG_ENV_VARS } from "./executor-config.js";
import type { HarnessProtocol } from "./harness-catalog.js";

/**
 * Harness Configs (Decision 0028, spec F05): the harness's own JSON configuration — Claude Code's
 * `settings.json`, opencode's `opencode.json` — owned by the app, stored per Workspace, edited in
 * Settings, and handed to the harness at launch.
 *
 * Decision 0027 made a Task's harness start from a blank, app-owned home, so the operator's
 * `~/.claude/settings.json` or `~/.config/opencode/opencode.json` is never read. This is the other
 * half: the configuration a run *does* get comes from a row here, selected by its Harness Profile,
 * so it can be named, versioned by `updatedAt`, duplicated, exported and imported — and no file on
 * the host is ever read or written to get it there.
 *
 * Delivery is by flag or variable, never by a file in `$HOME`: both reach a container exactly as
 * they reach a local process, so one mechanism holds on every Executor driver.
 */

/** The harnesses a config can be written for. Each has exactly one delivery, below. */
export const harnessConfigHarnessSchema = z.enum(["claude_code", "opencode"]);
export type HarnessConfigHarness = z.infer<typeof harnessConfigHarnessSchema>;

/** How a config reaches its harness: Claude Code's inline `--settings`, or a variable. */
export type HarnessConfigDelivery = { kind: "settings_flag" } | { kind: "env"; name: string };

export interface HarnessConfigTarget {
  /** What an operator would call the file this replaces. */
  readonly fileName: string;
  readonly label: string;
  readonly delivery: HarnessConfigDelivery;
  /** The editor's starting point: the harness's published JSON Schema, and nothing else. */
  readonly template: Readonly<Record<string, unknown>>;
}

export const HARNESS_CONFIG_TARGETS: Readonly<Record<HarnessConfigHarness, HarnessConfigTarget>> = {
  claude_code: {
    fileName: "settings.json",
    label: "Claude Code",
    // Flag settings outrank every settings file and are read whatever `--setting-sources` says.
    delivery: { kind: "settings_flag" },
    template: { $schema: "https://json.schemastore.org/claude-code-settings.json" },
  },
  opencode: {
    fileName: "opencode.json",
    label: "opencode",
    // opencode's inline config: the highest-precedence source it reads, and no file involved.
    // Verified on OpenCode 2.0.22 (`opencode debug config` lists it as a document source); v1 and
    // native v2 keys are both accepted in it (`providers`, `permissions`, `agents`, …).
    delivery: { kind: "env", name: "OPENCODE_CONFIG_CONTENT" },
    template: { $schema: "https://opencode.ai/config.json" },
  },
};

/** The variables a config's delivery sets — owned by the app, so a profile cannot set them. */
export const HARNESS_CONFIG_DELIVERY_ENV_VARS = Object.values(HARNESS_CONFIG_TARGETS).flatMap(
  ({ delivery }) => (delivery.kind === "env" ? [delivery.name] : []),
);

/**
 * Which config format a catalog row takes, or null when SoloW has no way to hand it one.
 *
 * Claude Code by protocol — stream-json is only ever the Claude CLI. opencode by key or by the
 * binary a custom row launches, since ACP alone says nothing about which agent answers.
 */
export function configHarnessFor(entry: {
  protocol: HarnessProtocol;
  key: string;
  command: string;
}): HarnessConfigHarness | null {
  if (entry.protocol === "claude_code_stream_json") return "claude_code";
  const binary = entry.command.split(/[\\/]/).pop() ?? "";
  if (entry.key === "opencode" || binary === "opencode") return "opencode";
  return null;
}

/** Inline in argv or an env var, so bounded well under any platform's `ARG_MAX`. */
export const HARNESS_CONFIG_MAX_BYTES = 64_000;

/** A JSON object — the root every supported harness's config file has. */
export const harnessConfigContentSchema = z
  .record(z.unknown())
  .refine((value) => JSON.stringify(value).length <= HARNESS_CONFIG_MAX_BYTES, {
    message: `a harness config is at most ${HARNESS_CONFIG_MAX_BYTES} bytes of JSON`,
  });
export type HarnessConfigContent = z.infer<typeof harnessConfigContentSchema>;

/** Variables no config may set: billing (Principle IV) and configuration discovery (0027). */
export const HARNESS_CONFIG_RESERVED_ENV_VARS: readonly string[] = [
  ...GUARDED_ENV_VARS,
  ...HARNESS_CONFIG_ENV_VARS,
  ...HARNESS_CONFIG_DELIVERY_ENV_VARS,
  "OPENCODE_API_KEY",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  // OpenCode 2's terminal-client config, merged over `cli.json`: the same discovery door.
  "OPENCODE_CLI_CONFIG_CONTENT",
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Request headers that carry a credential, however a provider spells them. */
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);

/**
 * A provider credential written into an opencode config, in either shape OpenCode 2 reads.
 *
 * v1's `provider.<id>.options.apiKey` is still accepted beside the native v2
 * `providers.<id>.settings.apiKey` (and `headers`), and both may sit in one file, so both are
 * checked — a guard that read only one spelling would be a guard with a documented way around it.
 */
function opencodeCredentialViolations(content: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const [root, blocks] of [
    ["provider", ["options", "settings"]],
    ["providers", ["settings", "options"]],
  ] as const) {
    const providers = content[root];
    if (!isObject(providers)) continue;
    for (const [id, provider] of Object.entries(providers)) {
      if (!isObject(provider)) continue;
      for (const block of blocks) {
        const settings = provider[block];
        if (isObject(settings) && "apiKey" in settings) {
          out.push(`${root}.${id}.${block}.apiKey belongs in the profile's Secret`);
        }
      }
      const headers = provider["headers"];
      if (isObject(headers)) {
        for (const name of Object.keys(headers)) {
          if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
            out.push(`${root}.${id}.headers.${name} belongs in the profile's Secret`);
          }
        }
      }
    }
  }
  return out;
}

/**
 * What in a config would route around the billing guard or back to the operator's own
 * configuration — empty when nothing does.
 *
 * A credential belongs in the Harness Profile's Secret, never in a config: a key here would be
 * stored in plain text and would override the billing mode the Profile declares. `extraReserved`
 * is the running catalog row's own two credential variables, known only at launch.
 */
export function harnessConfigViolations(
  harness: HarnessConfigHarness,
  content: Readonly<Record<string, unknown>>,
  extraReserved: readonly string[] = [],
): string[] {
  const reserved = new Set([...HARNESS_CONFIG_RESERVED_ENV_VARS, ...extraReserved]);
  const out: string[] = [];
  if (harness === "claude_code") {
    if (isObject(content["env"])) {
      for (const name of Object.keys(content["env"])) {
        if (reserved.has(name)) out.push(`env.${name} is owned by SoloW`);
      }
    }
    if ("apiKeyHelper" in content) out.push("apiKeyHelper would bypass the profile's credential");
  } else {
    out.push(...opencodeCredentialViolations(content));
  }
  return out;
}

const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().max(2000);

/** Rejects a config's content as a validation error naming every offending key. */
function refineContent<T extends { harness: HarnessConfigHarness; content: HarnessConfigContent }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  for (const message of harnessConfigViolations(value.harness, value.content)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message });
  }
}

export const HarnessConfigErrorCode = {
  /** Two configs with one name would be indistinguishable in a profile's picker. */
  NameTaken: "HARNESS_CONFIG_NAME_TAKEN",
  /** A Harness Profile still selects it; deleting it would change what that profile launches. */
  InUse: "HARNESS_CONFIG_IN_USE",
  /** The config is for a different harness than the profile runs. */
  HarnessMismatch: "HARNESS_CONFIG_HARNESS_MISMATCH",
} as const;
export type HarnessConfigErrorCode =
  (typeof HarnessConfigErrorCode)[keyof typeof HarnessConfigErrorCode];

export const harnessConfigDto = z
  .object({
    id: idSchema,
    name: z.string(),
    description: z.string().nullable(),
    harness: harnessConfigHarnessSchema,
    content: harnessConfigContentSchema,
    /** How many Harness Profiles launch with it — Delete is refused while this is above zero. */
    profileCount: z.number().int().nonnegative(),
  })
  .merge(timestampsSchema);
export type HarnessConfigDto = z.infer<typeof harnessConfigDto>;

export const listHarnessConfigsInput = z.object({
  harness: harnessConfigHarnessSchema.optional(),
});
export type ListHarnessConfigsInput = z.infer<typeof listHarnessConfigsInput>;

export const createHarnessConfigInput = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
    harness: harnessConfigHarnessSchema,
    content: harnessConfigContentSchema,
  })
  .superRefine(refineContent);
export type CreateHarnessConfigInput = z.infer<typeof createHarnessConfigInput>;

/**
 * The harness is what a config *is* — a profile already selecting it relies on that — so it is
 * restated rather than changeable: the DAL refuses one that disagrees with the row, and stating it
 * is what lets `content` be checked here, with every offending key named, rather than downstream.
 */
export const updateHarnessConfigInput = z
  .object({
    id: idSchema,
    harness: harnessConfigHarnessSchema,
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    content: harnessConfigContentSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.content) refineContent({ harness: value.harness, content: value.content }, ctx);
  });
export type UpdateHarnessConfigInput = z.infer<typeof updateHarnessConfigInput>;

export const duplicateHarnessConfigInput = z.object({
  id: idSchema,
  /** Absent: "<name> (copy)", numbered until free. */
  name: nameSchema.optional(),
});
export type DuplicateHarnessConfigInput = z.infer<typeof duplicateHarnessConfigInput>;

export const deleteHarnessConfigInput = z.object({ id: idSchema });
export type DeleteHarnessConfigInput = z.infer<typeof deleteHarnessConfigInput>;

/**
 * The portable form a config is shared in — downloaded from one Workspace, imported into another.
 * No ids, no timestamps, no Workspace: nothing that means something only where it came from.
 */
export const HARNESS_CONFIG_DOCUMENT_KIND = "solow.harness-config" as const;

export const harnessConfigDocument = z
  .object({
    kind: z.literal(HARNESS_CONFIG_DOCUMENT_KIND),
    version: z.literal(1),
    name: nameSchema,
    description: descriptionSchema.nullable().default(null),
    harness: harnessConfigHarnessSchema,
    content: harnessConfigContentSchema,
  })
  .superRefine(refineContent);
export type HarnessConfigDocument = z.infer<typeof harnessConfigDocument>;

export const exportHarnessConfigInput = z.object({ id: idSchema });
export type ExportHarnessConfigInput = z.infer<typeof exportHarnessConfigInput>;

/** An imported name that is taken gets the same "(copy)" suffix a duplicate does. */
export const importHarnessConfigInput = z.object({ document: harnessConfigDocument });
export type ImportHarnessConfigInput = z.infer<typeof importHarnessConfigInput>;

export function toHarnessConfigDocument(config: {
  name: string;
  description: string | null;
  harness: HarnessConfigHarness;
  content: HarnessConfigContent;
}): HarnessConfigDocument {
  return {
    kind: HARNESS_CONFIG_DOCUMENT_KIND,
    version: 1,
    name: config.name,
    description: config.description,
    harness: config.harness,
    content: config.content,
  };
}

/** `name`, else `name (copy)`, else `name (copy 2)`… — the first one `taken` does not hold. */
export function freeCopyName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 1; ; n++) {
    const candidate = `${name.slice(0, 100)} (copy${n === 1 ? "" : ` ${n}`})`;
    if (!taken.has(candidate)) return candidate;
  }
}
