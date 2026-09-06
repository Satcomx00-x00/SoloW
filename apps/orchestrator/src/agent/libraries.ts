import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AcpMcpServer } from "@solow/acp";
import type {
  AgentLibraries,
  AgentProtocol,
  ResolvedMcpServer,
  ResolvedSkill,
} from "@solow/contracts";

/**
 * How each agent runtime is told about the libraries (spec F24, Decision 0024).
 *
 * The library says *what* an MCP server or a Skill is; this module says *how* a given agent is
 * handed it, because the three runtimes SoloW drives take it three different ways:
 *
 *  - **Claude Code (stream-json)** takes `--mcp-config <file>` for servers and `--plugin-dir
 *    <dir>` for a plugin whose `skills/` are the Skills. Both are paths outside the worktree the
 *    agent creates for itself (`--worktree`), which SoloW cannot pre-populate — so nothing is
 *    written into the agent's checkout and nothing shows up in its diff.
 *  - **ACP agents** (opencode, Claude Code over ACP) take servers on `session/new.mcpServers`,
 *    the protocol's own channel. Skills have no channel: they are files the agent discovers in
 *    its working directory, so they are written into the worktree SoloW provisioned — under the
 *    directory that runtime scans — and excluded from git there, so they never reach a commit.
 *  - Anything else gets nothing, and says so, rather than an argument the binary would refuse.
 *
 * Every file lands under a directory the executor already mounts: the Task's own worktree
 * directory (`libraryDir` for generated config, `worktreePath` for the ACP Skills), so the
 * Docker driver sees the same absolute paths the local one does.
 */

export interface MaterializedLibraries {
  /** Extra arguments for the agent's command line. */
  extraArgs: string[];
  /** MCP servers for an ACP session; empty for runtimes that take them another way. */
  mcpServers: AcpMcpServer[];
  /** What was loaded, one line per item, for the transcript. */
  loaded: string[];
  /** What could not be loaded for this runtime, in words the operator can act on. */
  notices: string[];
}

const NOTHING: MaterializedLibraries = { extraArgs: [], mcpServers: [], loaded: [], notices: [] };

/** The `mcpServers` document Claude Code's `--mcp-config` reads. */
export function claudeMcpConfig(servers: readonly ResolvedMcpServer[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.name] =
      server.transport.kind === "stdio"
        ? {
            command: server.transport.command,
            args: server.transport.args,
            env: server.transport.env,
          }
        : { type: "http", url: server.transport.url, headers: server.transport.headers };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/** The same servers, as the ACP `session/new` request spells them. */
export function acpMcpServers(servers: readonly ResolvedMcpServer[]): AcpMcpServer[] {
  const pairs = (record: Record<string, string>) =>
    Object.entries(record).map(([name, value]) => ({ name, value }));
  return servers.map((server) =>
    server.transport.kind === "stdio"
      ? {
          name: server.name,
          command: server.transport.command,
          args: server.transport.args,
          env: pairs(server.transport.env),
        }
      : {
          type: "http" as const,
          name: server.name,
          url: server.transport.url,
          headers: pairs(server.transport.headers),
        },
  );
}

/**
 * The `SKILL.md` an inline Skill becomes. Both runtimes want YAML frontmatter with `name` and
 * `description`; a body the author already opened with `---` is trusted to carry its own.
 */
export function skillMarkdown(skill: ResolvedSkill & { source: { kind: "inline" } }): string {
  const body = skill.source.body.trimStart();
  if (body.startsWith("---")) return body.endsWith("\n") ? body : `${body}\n`;
  const description = skill.description.replace(/\n/g, " ").replace(/"/g, "'");
  return `---\nname: ${skill.name}\ndescription: "${description}"\n---\n\n${body.trimEnd()}\n`;
}

/** The directory a runtime scans for Skills, relative to the agent's working directory. */
export function skillsDirFor(catalogKey: string): string {
  return catalogKey === "opencode" ? ".opencode/skill" : ".claude/skills";
}

/** Write one Skill as `<root>/<name>/SKILL.md` (inline) or a copy of its directory (path). */
async function writeSkill(root: string, skill: ResolvedSkill): Promise<void> {
  const dir = join(root, skill.name);
  if (skill.source.kind === "inline") {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skillMarkdown({ ...skill, source: skill.source }));
    return;
  }
  const source = resolve(skill.source.path);
  const info = await stat(source);
  if (!info.isDirectory()) throw new Error(`skill "${skill.name}": ${source} is not a directory`);
  await stat(join(source, "SKILL.md")).catch(() => {
    throw new Error(`skill "${skill.name}": ${source} holds no SKILL.md`);
  });
  await mkdir(dirname(dir), { recursive: true });
  await cp(source, dir, { recursive: true, force: true });
}

/**
 * Where a worktree's git keeps its `info/exclude`. In a worktree `.git` is a file naming the
 * real git directory; in a plain checkout it is the directory itself.
 */
export async function gitInfoExcludePath(worktreePath: string): Promise<string | null> {
  const dotGit = join(worktreePath, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (!info) return null;
  if (info.isDirectory()) return join(dotGit, "info", "exclude");
  const pointer = (await readFile(dotGit, "utf8")).trim();
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match?.[1]) return null;
  return join(resolve(worktreePath, match[1].trim()), "info", "exclude");
}

/** Keep `pattern` out of `git status` and every diff of this worktree, without touching the repo's own ignore files. */
async function excludeFromGit(worktreePath: string, pattern: string): Promise<void> {
  const excludePath = await gitInfoExcludePath(worktreePath);
  if (!excludePath) return;
  const current = await readFile(excludePath, "utf8").catch(() => "");
  if (current.split("\n").some((line) => line.trim() === pattern)) return;
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(excludePath, `${current.trimEnd()}${current ? "\n" : ""}${pattern}\n`);
}

export async function materializeLibraries(opts: {
  libraries: AgentLibraries;
  protocol: AgentProtocol;
  catalogKey: string;
  /** Where generated config goes — a directory of the Task's own, mounted on every driver. */
  libraryDir: string;
  /** The worktree an ACP agent runs in, or null when the agent makes its own. */
  worktreePath: string | null;
}): Promise<MaterializedLibraries> {
  const { mcpServers, skills } = opts.libraries;
  if (mcpServers.length === 0 && skills.length === 0) return NOTHING;
  const loaded = [
    ...mcpServers.map((s) => `MCP server ${s.name}`),
    ...skills.map((s) => `skill ${s.name}`),
  ];

  if (opts.protocol === "claude_code_stream_json") {
    const extraArgs: string[] = [];
    // Absolute, whatever the caller passed: these paths travel as *arguments* to a process whose
    // cwd is the repository, not the orchestrator's — and `SOLOW_WORKTREE_ROOT` defaults to a
    // relative `.solow/worktrees`. Handed over as typed, `--mcp-config` was resolved under the
    // repository, and Claude Code exited with "MCP config file not found" before its first word.
    const libraryDir = resolve(opts.libraryDir);
    await mkdir(libraryDir, { recursive: true });
    if (mcpServers.length > 0) {
      const file = join(libraryDir, "mcp.json");
      await writeFile(file, claudeMcpConfig(mcpServers));
      extraArgs.push("--mcp-config", file);
    }
    if (skills.length > 0) {
      // A plugin is the one thing Claude Code loads Skills from without a project directory.
      const plugin = join(libraryDir, "plugin");
      await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(plugin, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name: "solow", description: "Skills from the SoloW library", version: "1.0.0" }, null, 2)}\n`,
      );
      for (const skill of skills) await writeSkill(join(plugin, "skills"), skill);
      extraArgs.push("--plugin-dir", plugin);
    }
    return { extraArgs, mcpServers: [], loaded, notices: [] };
  }

  if (opts.protocol === "acp") {
    const notices: string[] = [];
    if (skills.length > 0) {
      if (opts.worktreePath) {
        const relative = skillsDirFor(opts.catalogKey);
        for (const skill of skills) await writeSkill(join(opts.worktreePath, relative), skill);
        await excludeFromGit(opts.worktreePath, `/${relative}/`);
      } else {
        notices.push(
          `Skills were not loaded: this agent runs without a worktree SoloW provisioned, so there is nowhere it would read them from.`,
        );
      }
    }
    return { extraArgs: [], mcpServers: acpMcpServers(mcpServers), loaded, notices };
  }

  return {
    ...NOTHING,
    notices: [
      `MCP servers and Skills were not loaded: SoloW does not know how to hand them to a "${opts.protocol}" agent.`,
    ],
  };
}
