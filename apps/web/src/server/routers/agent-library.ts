import "server-only";
import {
  createMcpServerInput,
  createSkillInput,
  deleteMcpServerInput,
  deleteSkillInput,
  importSkillsInput,
  importSkillsOutput,
  listMcpServersInput,
  listSkillsInput,
  mcpServerDto,
  mcpServerListDto,
  scanSkillsInput,
  scanSkillsOutput,
  skillDto,
  skillListDto,
  unpackSkillsInput,
  updateMcpServerInput,
  updateSkillInput,
} from "@solow/contracts";
import {
  createMcpServer,
  createSkill,
  deleteMcpServer,
  deleteSkill,
  importSkills,
  listMcpServers,
  listSkills,
  scanSkills,
  unpackSkills,
  updateMcpServer,
  updateSkill,
} from "../dal/agent-library.js";
import { libraryProcedure, router, unwrap } from "../trpc.js";

/**
 * The agent libraries API (spec F24): `library.mcp.*` and `library.skill.*`.
 *
 * Every procedure is on `libraryProcedure` — `ff-core-program` and `ff-agent-libraries` — and
 * the whole namespace is withheld from the external MCP surface (`mcp/tools.ts`): what these
 * rows say is loaded into every agent, so an agent's token must not be able to write them.
 */
export const libraryRouter = router({
  mcp: router({
    list: libraryProcedure
      .meta({
        openapi: {
          method: "GET",
          path: "/library.mcp.list",
          tags: ["library"],
          protect: true,
          summary:
            "List this Workspace's MCP servers. Secrets referenced by a server's env or headers appear as references, never as values.",
        },
      })
      .input(listMcpServersInput)
      .output(mcpServerListDto)
      .query(async ({ ctx }) => unwrap(await listMcpServers(ctx.rctx))),

    create: libraryProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/library.mcp.create",
          tags: ["library"],
          protect: true,
          summary:
            "Add an MCP server — a stdio command or an HTTP endpoint — to the library. Each env variable or header is a literal or a reference to one of this Workspace's Secrets. `enabled` loads it into every agent run; off, it is loaded only by the Workflow Steps that name it.",
        },
      })
      .input(createMcpServerInput)
      .output(mcpServerDto)
      .mutation(async ({ ctx, input }) => unwrap(await createMcpServer(ctx.rctx, input))),

    update: libraryProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/library.mcp.update",
          tags: ["library"],
          protect: true,
          summary:
            "Change an MCP server's name, description, transport or Workspace-wide switch. A transport replaces the previous one whole.",
        },
      })
      .input(updateMcpServerInput)
      .output(mcpServerDto)
      .mutation(async ({ ctx, input }) => unwrap(await updateMcpServer(ctx.rctx, input))),

    delete: libraryProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/library.mcp.delete",
          tags: ["library"],
          protect: true,
          summary:
            "Remove an MCP server from the library. Refused while a Workflow Step still names it.",
        },
      })
      .input(deleteMcpServerInput)
      .output(mcpServerListDto)
      .mutation(async ({ ctx, input }) => {
        unwrap(await deleteMcpServer(ctx.rctx, input.id));
        return unwrap(await listMcpServers(ctx.rctx));
      }),
  }),

  skill: router({
    list: libraryProcedure
      .meta({
        openapi: {
          method: "GET",
          path: "/library.skill.list",
          tags: ["library"],
          protect: true,
          summary: "List this Workspace's Skills, with where each one's text comes from.",
        },
      })
      .input(listSkillsInput)
      .output(skillListDto)
      .query(async ({ ctx }) => unwrap(await listSkills(ctx.rctx))),

    create: libraryProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/library.skill.create",
          tags: ["library"],
          protect: true,
          summary:
            "Add a Skill — written inline as the SKILL.md the agent will read, or pointing at a directory on the host that holds one. `enabled` loads it into every agent run; off, only the Workflow Steps that name it load it.",
        },
      })
      .input(createSkillInput)
      .output(skillDto)
      .mutation(async ({ ctx, input }) => unwrap(await createSkill(ctx.rctx, input))),

    update: libraryProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/library.skill.update",
          tags: ["library"],
          protect: true,
          summary: "Change a Skill's name, description, source or Workspace-wide switch.",
        },
      })
      .input(updateSkillInput)
      .output(skillDto)
      .mutation(async ({ ctx, input }) => unwrap(await updateSkill(ctx.rctx, input))),

    scan: libraryProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/library.skill.scan",
          tags: ["library"],
          protect: true,
          summary:
            "Find every Skill — each directory holding a SKILL.md — under a directory on the host or in a git repository, which SoloW clones into its skills directory (and pulls forward on the next scan). Returns them named and described, marking the ones the library already holds. Nothing is imported.",
        },
      })
      .input(scanSkillsInput)
      .output(scanSkillsOutput)
      .mutation(async ({ ctx, input }) => unwrap(await scanSkills(ctx.rctx, input))),

    unpack: libraryProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/library.skill.unpack",
          tags: ["library"],
          protect: true,
          summary:
            "Unpack a base64-encoded .zip into SoloW's skills directory (under the archive's name, replaced on re-upload) and scan it the way `library.skill.scan` scans a directory. An archive naming a path outside its own directory is refused whole. Nothing is imported.",
        },
      })
      .input(unpackSkillsInput)
      .output(scanSkillsOutput)
      .mutation(async ({ ctx, input }) => unwrap(await unpackSkills(ctx.rctx, input))),

    import: libraryProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/library.skill.import",
          tags: ["library"],
          protect: true,
          summary:
            "Import Skills found by a scan, each as a directory source so the scripts and references beside its SKILL.md travel with it. A name already in the library, or a directory that no longer holds a SKILL.md, is skipped by name rather than failing the batch.",
        },
      })
      .input(importSkillsInput)
      .output(importSkillsOutput)
      .mutation(async ({ ctx, input }) => unwrap(await importSkills(ctx.rctx, input))),

    delete: libraryProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/library.skill.delete",
          tags: ["library"],
          protect: true,
          summary: "Remove a Skill from the library. Refused while a Workflow Step still names it.",
        },
      })
      .input(deleteSkillInput)
      .output(skillListDto)
      .mutation(async ({ ctx, input }) => {
        unwrap(await deleteSkill(ctx.rctx, input.id));
        return unwrap(await listSkills(ctx.rctx));
      }),
  }),
});
