import { describe, expect, it } from "bun:test";
import type { WorkflowCheckpoint } from "@solow/contracts";
import {
  CHECKPOINT_PRESETS,
  checkpointFor,
  checkpointMatches,
  checkpointPreset,
  globToRegExp,
} from "./checkpoints.js";

/**
 * Checkpoints (review analysis, point 4): the rules that decide which tool call stops for a
 * person. Pure, so what fires is a fact about the rule and the call, not about a hook.
 */

const push: WorkflowCheckpoint = { on: "command", match: "\\bgit push\\b", label: "Pushes" };
const schema: WorkflowCheckpoint = {
  on: "write",
  match: "**/migrations/**",
  label: "Writes a migration",
};

describe("checkpointMatches", () => {
  it("fires a command rule on the command line, case-insensitively, and on nothing else", () => {
    expect(checkpointMatches(push, { command: "git push origin HEAD" })).toBe(true);
    expect(checkpointMatches(push, { command: "GIT PUSH" })).toBe(true);
    expect(checkpointMatches(push, { command: "git pull" })).toBe(false);
    expect(checkpointMatches(push, { path: "git push" })).toBe(false);
  });

  it("fires a write rule on the path relative to the worktree, and on an absolute path outside it", () => {
    const cwd = "/wt/task-1";
    expect(
      checkpointMatches(schema, { path: "/wt/task-1/packages/db/migrations/0040.sql" }, cwd),
    ).toBe(true);
    expect(checkpointMatches(schema, { path: "migrations/0040.sql" }, cwd)).toBe(true);
    expect(checkpointMatches(schema, { path: "/wt/task-1/packages/db/schema.ts" }, cwd)).toBe(
      false,
    );
    // Written outside the worktree altogether: the glob still sees the whole path.
    expect(checkpointMatches(schema, { path: "/srv/app/migrations/x.sql" }, cwd)).toBe(true);
  });

  it("never fires a rule whose pattern does not compile", () => {
    expect(
      checkpointMatches({ on: "command", match: "(", label: "broken" }, { command: "(" }),
    ).toBe(false);
  });
});

describe("checkpointFor", () => {
  it("returns the first rule that fires, in the order the Step declared them", () => {
    const rules: WorkflowCheckpoint[] = [{ on: "command", match: "git", label: "Any git" }, push];
    expect(checkpointFor(rules, { command: "git push" })?.label).toBe("Any git");
    expect(checkpointFor([push, schema], { path: "migrations/a.sql" })?.label).toBe(
      "Writes a migration",
    );
    expect(checkpointFor([push, schema], { command: "ls" })).toBeNull();
  });
});

describe("globToRegExp", () => {
  it("reads the subset of glob everyone already knows", () => {
    expect(globToRegExp("**/migrations/**").test("migrations/a.sql")).toBe(true);
    expect(globToRegExp("**/migrations/**").test("packages/db/migrations/2026/a.sql")).toBe(true);
    expect(globToRegExp("packages/db/*").test("packages/db/schema.ts")).toBe(true);
    expect(globToRegExp("packages/db/*").test("packages/db/src/schema.ts")).toBe(false);
    expect(globToRegExp("**/*.{env,pem}").test(".env")).toBe(true);
    expect(globToRegExp("**/*.{env,pem}").test("a/b/c.pem")).toBe(true);
    expect(globToRegExp("**/*.{env,pem}").test("a/b/c.pemx")).toBe(false);
    expect(globToRegExp("**/{.env,.env.*}").test("apps/web/.env.local")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
    // Regex specials in a glob are letters, not operators.
    expect(globToRegExp("a+b.txt").test("a+b.txt")).toBe(true);
    expect(globToRegExp("a+b.txt").test("aab.txt")).toBe(false);
  });
});

describe("presets", () => {
  it("each compiles and catches what its hint says", () => {
    for (const preset of CHECKPOINT_PRESETS) {
      expect(checkpointPreset(preset.id)).toBe(preset);
      if (preset.on === "command") expect(() => new RegExp(preset.match)).not.toThrow();
    }
    const fires = (id: string, facts: { command?: string; path?: string }) =>
      checkpointMatches(checkpointPreset(id) as WorkflowCheckpoint, facts, "/wt");
    expect(fires("migrations", { command: "bun run db:migrate" })).toBe(true);
    expect(fires("migrations", { command: "bunx drizzle-kit generate" })).toBe(true);
    expect(fires("migrations", { command: "bun test" })).toBe(false);
    expect(fires("dependencies", { command: "bun add zod" })).toBe(true);
    expect(fires("dependencies", { command: "bun run build" })).toBe(false);
    expect(fires("publish", { command: "git push -u origin feat" })).toBe(true);
    expect(fires("destructive", { command: "rm -rf node_modules" })).toBe(true);
    expect(fires("destructive", { command: "git reset --hard HEAD~1" })).toBe(true);
    expect(fires("destructive", { command: "rm -f a.txt" })).toBe(false);
    expect(fires("schema", { path: "/wt/packages/db/migrations/0040.sql" })).toBe(true);
    expect(fires("secrets", { path: "/wt/apps/web/.env.local" })).toBe(true);
    expect(fires("secrets", { path: "/wt/apps/web/env.ts" })).toBe(false);
  });
});
