import { randomUUID } from "node:crypto";
import type { HarnessProtocol } from "@solow/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { harnessCatalog } from "./schema.js";

/**
 * The catalog rows every Workspace starts with (issue #10, opencode added 2026-08-28).
 *
 * Harness identity is a row rather than an enum, which means a brand-new Workspace with zero
 * catalog rows could not create even the harnesses SoloW ships — so whatever creates a Workspace
 * must call `ensureDefaultHarnessCatalog` immediately after, the same way it must create the
 * Workspace itself. Shared between the real sign-up hook (`auth.ts`) and the dev/test seed so
 * both paths guarantee the same thing.
 *
 * These are *defaults*, not a closed set: a Workspace can add its own rows through
 * `profile.agentCatalog.create`, and can edit these. Seeding them only means a fresh install has
 * something to point a Harness Profile at.
 *
 * The two env-var names on each row are what the billing guard sets and strips
 * (`resolveHarnessRunEnv` in `@solow/core`): the subscription one for a harness's own plan, the
 * metered one for a per-token provider key. They are names, never values.
 */
interface CatalogDefault {
  key: string;
  displayName: string;
  protocol: HarnessProtocol;
  command: string;
  argsTemplate: string[];
  /** How to get or upgrade the harness — quoted in a version refusal. Null for none. */
  installHint: string | null;
  /** The oldest build a run accepts (see `harnessCatalog.minVersion`). Null for no pin. */
  minVersion: string | null;
  subscriptionEnvVar: string;
  meteredEnvVar: string;
}

export const DEFAULT_HARNESS_CATALOG: readonly CatalogDefault[] = [
  {
    key: "claude_code",
    displayName: "Claude Code",
    protocol: "claude_code_stream_json",
    command: "claude",
    argsTemplate: [],
    installHint: null,
    // No pin: stream-json has no handshake that says which build is answering, so there would be
    // nothing to check it against (`HarnessVersionPin`).
    minVersion: null,
    subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    meteredEnvVar: "ANTHROPIC_API_KEY",
  },
  {
    /**
     * opencode speaks ACP natively — `opencode acp` is an Agent Client Protocol server, and it
     * negotiates protocol version 1, which is exactly what `@solow/acp` implements. So this is a
     * catalog row and nothing else: no new package, no runner, no protocol member. That is the
     * outcome Decision 0003 chose ACP for — a second harness should be configuration rather than
     * engineering — and this is the first row that actually demonstrates it.
     *
     * `OPENCODE_API_KEY` is opencode's own subscription key; `ANTHROPIC_API_KEY` is one provider
     * key among the hundred-odd it accepts, chosen because it is the provider SoloW's other
     * harness already uses. A Workspace wanting a different provider edits this row or adds its
     * own — which is precisely why the catalog is data.
     */
    key: "opencode",
    displayName: "opencode",
    protocol: "acp",
    command: "opencode",
    /*
     * `--auto`: approve every permission opencode asks for that its config does not deny. It is
     * opencode's own client switch, and `opencode acp` itself refuses it — under ACP SoloW is the
     * client, so the orchestrator takes it off the command line and answers the requests itself,
     * still logging each as decided by policy (`client-directives.ts`). `0046_opencode_auto.sql`
     * gives it to existing rows.
     */
    argsTemplate: ["acp", "--auto"],
    // SoloW ships opencode as an exact npm dependency and spawns that copy (`executor/
    // bundled-binaries.ts`), so an old build only answers when the bundled one is missing and
    // PATH supplied another — the fix is to put the bundled one back, not to chase `@latest`.
    installHint:
      "SoloW installs @opencode/cli@2.0.22 itself: reinstall its dependencies (bun install from source, or npx @satcomx00-x00/solow@latest)",
    /*
     * The build this row was verified against, end to end. Not a formality: `@solow/acp` reads
     * shapes opencode added along the way — the `configOptions` its 1.18 line answers
     * `session/new` with instead of `models`/`modes` (protocol.ts), the `agentInfo` this pin is
     * checked against — and an older opencode fails in ways that look like SoloW's fault (an
     * empty model list, a Profile with nothing to suggest). Raise it when a newer build has been
     * run through the same checks; `0044_opencode_2.sql` shows how existing rows get it.
     *
     * OpenCode 2 (2026-10-02): same `opencode acp`, same ACP protocol version 1, same
     * `configOptions` shape (plus an `effort` option), and `acp` still hosts its own server
     * rather than leaving the new background service running. The major release's breaking
     * changes — the plugin API, the HTTP server API and `tui.json` → `cli.json` — are surfaces
     * SoloW does not use; v1 `opencode.json` keys keep working beside the native v2 ones.
     */
    minVersion: "2.0.22",
    subscriptionEnvVar: "OPENCODE_API_KEY",
    meteredEnvVar: "ANTHROPIC_API_KEY",
  },
];

/** The key callers get an id back for — the harness a fresh Workspace's first Profile points at. */
const PRIMARY_KEY = "claude_code";

async function ensureRow(db: Db, workspaceId: string, entry: CatalogDefault): Promise<string> {
  const [existing] = await db
    .select({ id: harnessCatalog.id })
    .from(harnessCatalog)
    .where(and(eq(harnessCatalog.workspaceId, workspaceId), eq(harnessCatalog.key, entry.key)))
    .limit(1);
  if (existing) return existing.id;

  const id = randomUUID();
  await db.insert(harnessCatalog).values({ id, workspaceId, ...entry });
  return id;
}

/**
 * Seed every default row this Workspace is missing, and answer with the id of the primary one.
 *
 * Check-then-insert per row, not a transaction: a Workspace is created by exactly one path
 * (sign-up is single-Owner; the seed is dev/test-only and not run concurrently with itself), so
 * there is no concurrent writer this needs to race against. Per row rather than "does the
 * Workspace have any rows at all", so a Workspace created before a default existed picks it up
 * on the next call instead of being stuck with the set it was born with.
 */
export async function ensureDefaultHarnessCatalog(db: Db, workspaceId: string): Promise<string> {
  let primary: string | undefined;
  for (const entry of DEFAULT_HARNESS_CATALOG) {
    const id = await ensureRow(db, workspaceId, entry);
    if (entry.key === PRIMARY_KEY) primary = id;
  }
  if (!primary) throw new Error(`no default catalog entry keyed ${PRIMARY_KEY}`);
  return primary;
}
