import type { WorkflowCheckpoint } from "@solow/contracts";

/**
 * Workflow checkpoints (review analysis of task 9f4bd3e9, point 4): which tool calls of a
 * Step's harness stop for a person.
 *
 * Pure, and shared: the orchestrator applies these rules to what the harness's hook reports,
 * and the designer offers the presets below and could preview a match. The facts a rule reads
 * are deliberately thin — the command line, or the path written — so a rule never sees the
 * contents of a file being written (Principle IV) and the same rule means the same thing on
 * every harness that can report a tool call.
 */

/** What one tool call amounts to, for the rules. Whichever is absent, the rules of that kind skip. */
export interface ToolCallFacts {
  command?: string | null;
  path?: string | null;
}

/** A ready-made checkpoint the designer offers, keyed so a pipeline can name it. */
export interface CheckpointPreset extends WorkflowCheckpoint {
  id: string;
  /** What it catches, for the designer's list. */
  hint: string;
}

/**
 * The checkpoints most Build Steps want, worded as the request the operator will read.
 *
 * Each is one thing a reviewer of task 9f4bd3e9 would have wanted to be asked about before it
 * happened, rather than shown afterwards inside a 400-file diff. Patterns are deliberately broad
 * — a checkpoint that fires once too often costs a click; one that misses costs the reason it
 * exists.
 */
export const CHECKPOINT_PRESETS: readonly CheckpointPreset[] = [
  {
    id: "migrations",
    on: "command",
    match:
      "drizzle-kit|db:(generate|migrate|push)|prisma (migrate|db push)|alembic (upgrade|downgrade|revision)|rails db:|knex migrate|flyway|liquibase|migrate\\b",
    label: "Runs a database migration",
    hint: "drizzle-kit, prisma migrate, alembic, rails db:, knex, flyway…",
  },
  {
    id: "dependencies",
    on: "command",
    match:
      "\\b(bun|npm|pnpm|yarn) (add|install|remove|i|rm|up|update)\\b|pip install|cargo add|go get",
    label: "Changes the dependencies",
    hint: "bun add, npm install, pip install, cargo add…",
  },
  {
    id: "publish",
    on: "command",
    match: "\\bgit push\\b|\\bgh (pr|release) create|\\bnpm publish\\b|\\bdocker push\\b",
    label: "Pushes or publishes",
    hint: "git push, gh pr create, npm publish, docker push",
  },
  {
    id: "destructive",
    on: "command",
    match:
      "\\brm -[a-z]*r[a-z]*f|\\bgit (reset --hard|clean -[a-z]*f|push --force|branch -D)|\\bdrop (table|database|schema)\\b|\\btruncate\\b",
    label: "Destroys something",
    hint: "rm -rf, git reset --hard, git clean -f, DROP TABLE…",
  },
  {
    id: "schema",
    on: "write",
    match: "**/{migrations,migration,drizzle,prisma}/**",
    label: "Writes a migration",
    hint: "any file under a migrations, drizzle or prisma directory",
  },
  {
    id: "secrets",
    on: "write",
    match: "**/{.env,.env.*,*.pem,*.key,id_rsa*}",
    label: "Writes an environment file or a key",
    hint: ".env, .env.local, *.pem, *.key",
  },
];

/** The preset with this id, or null — a pipeline may name one that a later build renamed. */
export function checkpointPreset(id: string): CheckpointPreset | null {
  return CHECKPOINT_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * A glob, as the file-matching subset everyone already knows: `**` crosses directories, `*` and
 * `?` stay inside one, `{a,b}` is either. Anchored — a glob matches the whole path or nothing.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` also matches an empty prefix, so `**/migrations/**` catches `migrations/a.sql`.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
      } else {
        const alternatives = glob
          .slice(i + 1, close)
          .split(",")
          .map((alt) =>
            alt.replace(/[.+^$()|[\]\\?*{}]/g, (c) => `\\${c}`).replace(/\\\*/g, "[^/]*"),
          );
        out += `(?:${alternatives.join("|")})`;
        i = close;
      }
    } else {
      out += ch.replace(/[.+^$()|[\]\\]/g, (c) => `\\${c}`);
    }
  }
  return new RegExp(`^${out}$`);
}

/** The path a glob is matched against: relative to the worktree when it is inside it. */
function pathForMatching(path: string, cwd: string | null | undefined): string {
  if (cwd && (path === cwd || path.startsWith(`${cwd.replace(/\/$/, "")}/`))) {
    return path.slice(cwd.replace(/\/$/, "").length + 1);
  }
  return path;
}

/** Whether one rule fires on one tool call. A rule whose pattern does not compile never fires. */
export function checkpointMatches(
  rule: WorkflowCheckpoint,
  facts: ToolCallFacts,
  cwd?: string | null,
): boolean {
  if (rule.on === "command") {
    if (!facts.command) return false;
    try {
      return new RegExp(rule.match, "i").test(facts.command);
    } catch {
      return false;
    }
  }
  if (!facts.path) return false;
  const relative = pathForMatching(facts.path, cwd);
  const regexp = globToRegExp(rule.match);
  return regexp.test(relative) || regexp.test(facts.path);
}

/** The first checkpoint a tool call trips, in the order the Step declared them, or null. */
export function checkpointFor(
  rules: readonly WorkflowCheckpoint[],
  facts: ToolCallFacts,
  cwd?: string | null,
): WorkflowCheckpoint | null {
  return rules.find((rule) => checkpointMatches(rule, facts, cwd)) ?? null;
}

/** One line per rule, for a transcript notice: what was armed when the harness started. */
export function describeCheckpoints(rules: readonly WorkflowCheckpoint[]): string {
  return rules.map((rule) => `${rule.label} (${rule.on}: ${rule.match})`).join("; ");
}
