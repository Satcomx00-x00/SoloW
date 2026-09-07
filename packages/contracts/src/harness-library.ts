import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";

/**
 * The harness libraries: MCP servers and Skills, kept in one place and loaded into every harness
 * that runs (issue: harness libraries; spec F24).
 *
 * Two libraries, one shape of decision. An item is either *enabled* — loaded into every harness
 * run in the Workspace, whatever the Task or the Step — or it is not, and is then loaded only
 * where a Workflow Step names it (`workflowStepDto.mcpServerIds` / `skillIds`). A Step's
 * selection is additive: it can bring an item in, never keep an enabled one out, because "on
 * everywhere" is what the toggle in the library promised.
 *
 * How an item reaches the harness is the *runtime's* concern, not the library's: Claude Code takes
 * `--mcp-config` and `--plugin-dir`, an ACP agent takes `session/new.mcpServers` and a skills
 * directory in its worktree. The library stores what the item *is*; `apps/orchestrator`'s
 * loaders decide how each protocol is told about it.
 */

/**
 * A name that doubles as an identifier on the harness's side — the key of an MCP server in a
 * config file, the directory of a Skill. Lower-case, so the same name means the same thing on
 * every filesystem the harness may run on.
 */
export const libraryNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    "lower-case letters, digits and dashes, starting with one of the first two",
  );

/**
 * One value an MCP server is started with — an environment variable or an HTTP header.
 *
 * Either a literal, for the values that are not secrets (`LOG_LEVEL=debug`), or a reference to
 * a Secret in the vault, for the ones that are. The reference is what the API stores and
 * returns; the value behind it is decrypted only by the run loop, at the moment the harness is
 * started, and never travels through a DTO (Principle IV — the same rule as a Harness Profile's
 * credential).
 */
/**
 * One env variable or header value: typed in, or a Secret by id. A Secret may carry a `prefix`
 * written in front of the decrypted value at run time — `Bearer ` is the one every remote MCP
 * endpoint wants in its `Authorization` header — so the token itself stays a Secret and the
 * scheme stays visible in the config.
 */
export const mcpConfigValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string().max(4000) }),
  z.object({
    kind: z.literal("secret"),
    secretId: idSchema,
    prefix: z.string().max(64).optional(),
  }),
]);
export type McpConfigValue = z.infer<typeof mcpConfigValueSchema>;

const envVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name");
const headerName = z.string().regex(/^[A-Za-z0-9-]+$/, "an HTTP header name");

/**
 * How the harness reaches the server: a process it spawns and talks to over stdio, or an HTTP
 * endpoint it connects to. Both are what Claude Code's `--mcp-config` and the ACP `session/new`
 * request understand; SSE-only servers are reached through the `http` shape, which the
 * runtimes negotiate down themselves.
 */
export const mcpServerTransportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stdio"),
    command: z.string().min(1).max(500),
    args: z.array(z.string().max(2000)).max(64).default([]),
    env: z.record(envVarName, mcpConfigValueSchema).default({}),
  }),
  z.object({
    kind: z.literal("http"),
    url: z.string().url().max(2000),
    headers: z.record(headerName, mcpConfigValueSchema).default({}),
  }),
]);
export type McpServerTransport = z.infer<typeof mcpServerTransportSchema>;

/**
 * Where a Skill's text comes from.
 *
 * `inline` is a Skill written in SoloW — the body *is* the `SKILL.md` the harness will read, and
 * SoloW writes the file at launch. `path` is a directory on the host that already holds a
 * `SKILL.md` (and whatever files it references): a checkout of a skills repository, a
 * directory shared with an editor. It is read at launch, every launch, so an edit to the
 * directory is the next run's Skill. Fetching a remote repository is deliberately not a source:
 * a clone at launch is a network dependency inside the run loop, and the checkout the operator
 * keeps is the same thing without it.
 */
export const skillSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline"), body: z.string().min(1).max(200_000) }),
  z.object({ kind: z.literal("path"), path: z.string().min(1).max(4000) }),
]);
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const HarnessLibraryErrorCode = {
  /** Two items with one name would be one key on the harness's side — a coin flip. */
  NameTaken: "AGENT_LIBRARY_NAME_TAKEN",
  /** A Workflow Step still names this item; deleting it would leave the Step pointing at nothing. */
  InUse: "AGENT_LIBRARY_IN_USE",
  /** The item, or a Secret it references, is not in this Workspace (Principle V). */
  NotInWorkspace: "AGENT_LIBRARY_NOT_IN_WORKSPACE",
  /** A Secret an MCP server references is gone, so the server cannot be started as configured. */
  SecretMissing: "AGENT_LIBRARY_SECRET_MISSING",
  /** The directory to import Skills from is not there, or is not a directory. */
  ImportSourceNotFound: "AGENT_LIBRARY_IMPORT_SOURCE_NOT_FOUND",
  /** The repository to import Skills from could not be fetched: not a repository URL, or its host would not serve the archive. */
  ImportCloneFailed: "AGENT_LIBRARY_IMPORT_CLONE_FAILED",
  /** The uploaded file is not a zip archive SoloW can unpack, or holds a path it will not write. */
  ImportArchiveInvalid: "AGENT_LIBRARY_IMPORT_ARCHIVE_INVALID",
} as const;
export type HarnessLibraryErrorCode =
  (typeof HarnessLibraryErrorCode)[keyof typeof HarnessLibraryErrorCode];

// ---- MCP servers ----

export const mcpServerDto = z
  .object({
    id: idSchema,
    name: libraryNameSchema,
    description: z.string().nullable(),
    transport: mcpServerTransportSchema,
    /** Loaded into every harness run in the Workspace. Off: loaded only where a Step names it. */
    enabled: z.boolean(),
  })
  .merge(timestampsSchema);
export type McpServerDto = z.infer<typeof mcpServerDto>;

export const createMcpServerInput = z.object({
  name: libraryNameSchema,
  description: z.string().max(2000).optional(),
  transport: mcpServerTransportSchema,
  enabled: z.boolean().default(false),
});
export type CreateMcpServerInput = z.infer<typeof createMcpServerInput>;

export const updateMcpServerInput = z.object({
  id: idSchema,
  name: libraryNameSchema.optional(),
  description: z.string().max(2000).nullable().optional(),
  transport: mcpServerTransportSchema.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerInput>;

export const deleteMcpServerInput = z.object({ id: idSchema });
export const listMcpServersInput = z.object({});
export const mcpServerListDto = z.array(mcpServerDto);
export type McpServerListDto = z.infer<typeof mcpServerListDto>;

// ---- Skills ----

export const skillDto = z
  .object({
    id: idSchema,
    name: libraryNameSchema,
    /** One line, shown in the library and written into the Skill's frontmatter. */
    description: z.string(),
    source: skillSourceSchema,
    enabled: z.boolean(),
  })
  .merge(timestampsSchema);
export type SkillDto = z.infer<typeof skillDto>;

export const createSkillInput = z.object({
  name: libraryNameSchema,
  description: z.string().min(1).max(500),
  source: skillSourceSchema,
  enabled: z.boolean().default(false),
});
export type CreateSkillInput = z.infer<typeof createSkillInput>;

export const updateSkillInput = z.object({
  id: idSchema,
  name: libraryNameSchema.optional(),
  description: z.string().min(1).max(500).optional(),
  source: skillSourceSchema.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateSkillInput = z.infer<typeof updateSkillInput>;

export const deleteSkillInput = z.object({ id: idSchema });
export const listSkillsInput = z.object({});
export const skillListDto = z.array(skillDto);
export type SkillListDto = z.infer<typeof skillListDto>;

// ---- Importing Skills in bulk ----

/**
 * Where a bulk import reads from: a directory on the host, or a repository whose archive SoloW
 * fetches over HTTPS (its default branch, or `#ref`) into its own skills directory, again on
 * every scan. Either way, every directory holding a `SKILL.md` becomes one Skill of the `path`
 * kind, so the scripts, references and assets beside that file travel with it.
 */
export const skillImportSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal("git"), url: z.string().min(1).max(2000) }),
]);
export type SkillImportSource = z.infer<typeof skillImportSourceSchema>;

export const scanSkillsInput = z.object({ source: skillImportSourceSchema });
export type ScanSkillsInput = z.infer<typeof scanSkillsInput>;

export const scannedSkillDto = z.object({
  name: libraryNameSchema,
  description: z.string(),
  /** The directory holding the SKILL.md — what the imported Skill's `path` source will be. */
  path: z.string(),
  /** The same directory, relative to what was scanned; what the picker shows. */
  relativePath: z.string(),
  /** How many files sit in that directory, the SKILL.md included — scripts and references count. */
  files: z.number().int().nonnegative(),
  /** A Skill of this name is already in the library; importing again would be refused. */
  existing: z.boolean(),
});
export type ScannedSkillDto = z.infer<typeof scannedSkillDto>;

export const scanSkillsOutput = z.object({
  /** The directory that was scanned — the clone, for a repository. */
  root: z.string(),
  skills: z.array(scannedSkillDto),
});
export type ScanSkillsOutput = z.infer<typeof scanSkillsOutput>;

/**
 * A `.zip` dropped on the library: unpacked into SoloW's skills directory under the archive's
 * name, then scanned like a directory. Base64 in JSON rather than multipart, so it rides the
 * same procedure, flag and OpenAPI surface as the rest of the library; 40 MB of base64 is
 * ~30 MB of archive, which is far past any Skill and well short of anything the API should hold
 * in memory.
 */
export const unpackSkillsInput = z.object({
  fileName: z.string().min(1).max(200),
  zipBase64: z.string().min(1).max(40_000_000),
});
export type UnpackSkillsInput = z.infer<typeof unpackSkillsInput>;

export const importSkillsInput = z.object({
  skills: z
    .array(
      z.object({
        name: libraryNameSchema,
        description: z.string().min(1).max(500),
        path: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(200),
  enabled: z.boolean().default(false),
});
export type ImportSkillsInput = z.infer<typeof importSkillsInput>;

export const importSkillsOutput = z.object({
  imported: skillListDto,
  /** Names that were not imported: already in the library, or no SKILL.md at that path any more. */
  skipped: z.array(libraryNameSchema),
});
export type ImportSkillsOutput = z.infer<typeof importSkillsOutput>;

// ---- What a run is handed ----

/**
 * An MCP server as the harness will be started with it: every value resolved. Built by the run
 * loop from the library and the vault, inside the durable step that spawns the harness, and never
 * stored — it carries decrypted Secrets.
 */
export interface ResolvedMcpServer {
  name: string;
  transport:
    | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
    | { kind: "http"; url: string; headers: Record<string, string> };
}

/** A Skill as the loader will write it: the text is still where the source says it is. */
export interface ResolvedSkill {
  name: string;
  description: string;
  source: SkillSource;
}

/** What one harness run loads: the enabled items, plus whatever its Step named. */
export interface HarnessLibraries {
  mcpServers: ResolvedMcpServer[];
  skills: ResolvedSkill[];
}
