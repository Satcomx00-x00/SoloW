/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLibraries } from "@solow/contracts";
import {
  acpMcpServers,
  claudeMcpConfig,
  gitInfoExcludePath,
  materializeLibraries,
  skillMarkdown,
} from "./libraries.js";

/**
 * How each runtime is handed the libraries (spec F24, Decision 0024): the files, the arguments
 * and the protocol objects — checked on disk, because a path the agent cannot read is the whole
 * failure mode.
 */

const LIBRARIES: AgentLibraries = {
  mcpServers: [
    {
      name: "github",
      transport: {
        kind: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "ghp_x" },
      },
    },
    {
      name: "docs",
      transport: {
        kind: "http",
        url: "https://docs.example/mcp",
        headers: { Authorization: "Bearer t" },
      },
    },
  ],
  skills: [
    {
      name: "review-checklist",
      description: 'How we "review"',
      source: { kind: "inline", body: "# Review\n\nCheck the tests." },
    },
  ],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "solow-libraries-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("the shapes each runtime takes", () => {
  it("writes Claude Code's mcp.json with both transports", () => {
    expect(JSON.parse(claudeMcpConfig(LIBRARIES.mcpServers))).toEqual({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "ghp_x" },
        },
        docs: {
          type: "http",
          url: "https://docs.example/mcp",
          headers: { Authorization: "Bearer t" },
        },
      },
    });
  });

  it("spells the same servers the way ACP's session/new wants them", () => {
    expect(acpMcpServers(LIBRARIES.mcpServers)).toEqual([
      {
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: [{ name: "GITHUB_TOKEN", value: "ghp_x" }],
      },
      {
        type: "http",
        name: "docs",
        url: "https://docs.example/mcp",
        headers: [{ name: "Authorization", value: "Bearer t" }],
      },
    ]);
  });

  it("gives an inline skill the frontmatter both runtimes want, unless it brought its own", () => {
    const [skill] = LIBRARIES.skills;
    if (skill?.source.kind !== "inline") throw new Error("fixture");
    expect(skillMarkdown({ ...skill, source: skill.source })).toBe(
      "---\nname: review-checklist\ndescription: \"How we 'review'\"\n---\n\n# Review\n\nCheck the tests.\n",
    );
    const own = { ...skill, source: { kind: "inline" as const, body: "---\nname: x\n---\nBody" } };
    expect(skillMarkdown(own)).toBe("---\nname: x\n---\nBody\n");
  });
});

describe("materializeLibraries", () => {
  it("hands Claude Code a config file and a plugin directory, by argument, outside any worktree", async () => {
    const libraryDir = join(root, "task", ".solow-libraries");
    const out = await materializeLibraries({
      libraries: LIBRARIES,
      protocol: "claude_code_stream_json",
      catalogKey: "claude_code",
      libraryDir,
      worktreePath: null,
    });
    expect(out.extraArgs).toEqual([
      "--mcp-config",
      join(libraryDir, "mcp.json"),
      "--plugin-dir",
      join(libraryDir, "plugin"),
    ]);
    expect(out.mcpServers).toEqual([]);
    expect(out.notices).toEqual([]);
    expect(out.loaded).toEqual(["MCP server github", "MCP server docs", "skill review-checklist"]);
    expect(
      JSON.parse(await readFile(join(libraryDir, "mcp.json"), "utf8")).mcpServers.github.env,
    ).toEqual({
      GITHUB_TOKEN: "ghp_x",
    });
    expect(
      JSON.parse(
        await readFile(join(libraryDir, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
      ).name,
    ).toBe("solow");
    expect(
      await readFile(join(libraryDir, "plugin", "skills", "review-checklist", "SKILL.md"), "utf8"),
    ).toContain("# Review");
  });

  it("gives Claude Code absolute paths even for a relative library dir, since the agent's cwd is the repository", async () => {
    // The default SOLOW_WORKTREE_ROOT is relative; a relative --mcp-config is resolved by Claude
    // Code against *its* cwd, which is the repository, where the file is not.
    const before = process.cwd();
    process.chdir(root);
    try {
      const out = await materializeLibraries({
        libraries: LIBRARIES,
        protocol: "claude_code_stream_json",
        catalogKey: "claude_code",
        libraryDir: join("rel", "libs"),
        worktreePath: null,
      });
      expect(out.extraArgs).toEqual([
        "--mcp-config",
        join(root, "rel", "libs", "mcp.json"),
        "--plugin-dir",
        join(root, "rel", "libs", "plugin"),
      ]);
      await stat(join(root, "rel", "libs", "mcp.json"));
    } finally {
      process.chdir(before);
    }
  });

  it("hands an ACP agent its servers over the protocol and its skills in the worktree, excluded from git", async () => {
    // A worktree: `.git` is a file pointing at the real git directory.
    const worktree = join(root, "wt");
    const gitdir = join(root, "repo", ".git", "worktrees", "wt");
    await mkdir(worktree, { recursive: true });
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${gitdir}\n`);

    const out = await materializeLibraries({
      libraries: LIBRARIES,
      protocol: "acp",
      catalogKey: "opencode",
      libraryDir: join(root, "task", ".solow-libraries"),
      worktreePath: worktree,
    });
    expect(out.extraArgs).toEqual([]);
    expect(out.mcpServers.map((s) => s.name)).toEqual(["github", "docs"]);
    expect(
      await readFile(join(worktree, ".opencode", "skill", "review-checklist", "SKILL.md"), "utf8"),
    ).toContain("name: review-checklist");
    expect(await gitInfoExcludePath(worktree)).toBe(join(gitdir, "info", "exclude"));
    expect(await readFile(join(gitdir, "info", "exclude"), "utf8")).toBe("/.opencode/skill/\n");
    // Nothing was written for Claude Code's sake.
    expect(await stat(join(root, "task")).catch(() => null)).toBeNull();
  });

  it("puts a Claude-over-ACP agent's skills where Claude looks, and adds to an existing exclude file once", async () => {
    const worktree = join(root, "checkout");
    await mkdir(join(worktree, ".git", "info"), { recursive: true });
    await writeFile(join(worktree, ".git", "info", "exclude"), "*.log\n");
    for (let i = 0; i < 2; i += 1) {
      await materializeLibraries({
        libraries: { mcpServers: [], skills: LIBRARIES.skills },
        protocol: "acp",
        catalogKey: "claude_acp",
        libraryDir: join(root, "task", ".solow-libraries"),
        worktreePath: worktree,
      });
    }
    expect(
      await stat(join(worktree, ".claude", "skills", "review-checklist", "SKILL.md")),
    ).toBeTruthy();
    expect(await readFile(join(worktree, ".git", "info", "exclude"), "utf8")).toBe(
      "*.log\n/.claude/skills/\n",
    );
  });

  it("copies a directory-backed skill whole, and refuses one with no SKILL.md", async () => {
    const source = join(root, "skills", "deploy");
    await mkdir(join(source, "scripts"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: deploy\ndescription: d\n---\nRun it.\n");
    await writeFile(join(source, "scripts", "go.sh"), "#!/bin/sh\n");
    const libraryDir = join(root, "task", ".solow-libraries");
    await materializeLibraries({
      libraries: {
        mcpServers: [],
        skills: [{ name: "deploy", description: "d", source: { kind: "path", path: source } }],
      },
      protocol: "claude_code_stream_json",
      catalogKey: "claude_code",
      libraryDir,
      worktreePath: null,
    });
    expect(
      await readFile(join(libraryDir, "plugin", "skills", "deploy", "scripts", "go.sh"), "utf8"),
    ).toBe("#!/bin/sh\n");

    const empty = join(root, "skills", "empty");
    await mkdir(empty, { recursive: true });
    await expect(
      materializeLibraries({
        libraries: {
          mcpServers: [],
          skills: [{ name: "empty", description: "e", source: { kind: "path", path: empty } }],
        },
        protocol: "claude_code_stream_json",
        catalogKey: "claude_code",
        libraryDir,
        worktreePath: null,
      }),
    ).rejects.toThrow(/holds no SKILL.md/);
  });

  it("says so, rather than guessing, for a runtime it cannot hand them to, and is silent when there is nothing", async () => {
    const out = await materializeLibraries({
      libraries: LIBRARIES,
      protocol: "cli_passthrough" as never,
      catalogKey: "other",
      libraryDir: join(root, "x"),
      worktreePath: null,
    });
    expect(out.extraArgs).toEqual([]);
    expect(out.notices[0]).toContain("does not know how to hand them");
    const nothing = await materializeLibraries({
      libraries: { mcpServers: [], skills: [] },
      protocol: "claude_code_stream_json",
      catalogKey: "claude_code",
      libraryDir: join(root, "y"),
      worktreePath: null,
    });
    expect(nothing).toEqual({ extraArgs: [], mcpServers: [], loaded: [], notices: [] });
    expect(await stat(join(root, "y")).catch(() => null)).toBeNull();
  });
});
