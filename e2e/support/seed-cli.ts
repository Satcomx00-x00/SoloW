/// <reference types="bun-types" />
/**
 * E2E fixture seeding, run as a `bun` subprocess (issue #15).
 *
 * The Playwright test runner itself is Node, not Bun (see the note this replaces in
 * `isolation.spec.ts`), so a spec file cannot import `@solow/db` directly — that package
 * reaches `bun:sqlite`. Every other place this suite needs the database from outside a browser
 * page already solves this by shelling out to a `bun run` subprocess (`prepareFixture`'s
 * `db:migrate`/`db:seed`); this is the same pattern for the two things a spec needs mid-run:
 *
 *   bun run e2e/support/seed-cli.ts tenants
 *     → creates the two Workspaces this suite runs against, each with its agent catalog.
 *
 *   bun run e2e/support/seed-cli.ts issue <workspaceId> <title>
 *     → inserts one Issue into an existing Workspace, prints its id.
 *
 *   bun run e2e/support/seed-cli.ts task <workspaceId> <title>
 *     → inserts a complete, self-contained graph (secret, agent profile, executor profile,
 *       repository, Issue, Task) into an existing Workspace, prints the Task's id.
 *
 * There is no `issue.create` or UI form any more (every real Issue is imported from a connected
 * GitHub/GitLab repository) — this is test-only seeding, the same as `packages/db/src/seed.ts`
 * and every unit test's fixtures, not a second way to create an Issue in the product itself.
 */

import {
  agentProfile,
  bootstrapWorkspace,
  createDb,
  encryptSecret,
  ensureDefaultAgentCatalog,
  executorProfile,
  issue,
  repository,
  secret,
  task,
  taskRepository,
  workspace,
} from "@solow/db";

async function seedIssue(workspaceId: string, repoName: string, title: string): Promise<void> {
  const db = createDb();
  /*
   * The Issue is attached to a Repository, because the product's own Issues always are:
   * `createIssueInput` requires one precisely so the Task-creation picker's repository filter
   * can find it — "a repository-less Issue would be a dead end there". This seed used to insert
   * `repositoryId: null`, which is a row the product can no longer produce, and the suite spent
   * its time asserting against a picker that (correctly) refused to list it.
   *
   * Resolved by name at seed time rather than seeded alongside, because the Repository is
   * connected through the UI in the same test run and its id is not knowable in advance. `-`
   * keeps the unattached shape reachable for the one test that wants it (the cross-Workspace
   * listing check, where nobody ever opens a picker on it).
   */
  let repositoryId: string | null = null;
  if (repoName !== "-") {
    // Filtered in JS rather than SQL so this package needs no drizzle-orm of its own — a test
    // Workspace holds a handful of repositories, and a seed is not where a query plan matters.
    const rows = await db.select().from(repository);
    const repo = rows.find((r) => r.workspaceId === workspaceId && r.name === repoName);
    if (!repo) throw new Error(`seed-cli: no repository named "${repoName}" in ${workspaceId}`);
    repositoryId = repo.id;
  }
  const [row] = await db.insert(issue).values({ workspaceId, title, repositoryId }).returning();
  if (!row) throw new Error("failed to seed issue");
  console.log(JSON.stringify({ id: row.id, title: row.title }));
}

async function seedTask(workspaceId: string, title: string): Promise<void> {
  const db = createDb();
  const suffix = crypto.randomUUID();

  const [sec] = await db
    .insert(secret)
    .values({
      workspaceId,
      name: `e2e-secret-${suffix}`,
      kind: "subscription_token",
      ciphertext: encryptSecret("e2e-fixture-token"),
    })
    .returning();
  if (!sec) throw new Error("failed to seed secret");

  const agentCatalogId = await ensureDefaultAgentCatalog(db, workspaceId);
  const [agent] = await db
    .insert(agentProfile)
    .values({
      workspaceId,
      name: `e2e-agent-${suffix}`,
      agentCatalogId,
      authMode: "subscription",
      secretId: sec.id,
    })
    .returning();
  const [executor] = await db
    .insert(executorProfile)
    .values({ workspaceId, name: `e2e-executor-${suffix}`, kind: "local" })
    .returning();
  const [repo] = await db
    .insert(repository)
    .values({
      workspaceId,
      name: `e2e-repo-${suffix}`,
      source: "local_path",
      location: `/tmp/e2e-fixture-${suffix}`,
    })
    .returning();
  const [iss] = await db.insert(issue).values({ workspaceId, title }).returning();
  if (!agent || !executor || !repo || !iss) throw new Error("failed to seed task graph");

  const [row] = await db
    .insert(task)
    .values({
      workspaceId,
      issueId: iss.id,
      title,
      agentProfileId: agent.id,
      executorProfileId: executor.id,
    })
    .returning();
  if (!row) throw new Error("failed to seed task");
  // The Task's Repository attachment (issue #7). A Task with none cannot be launched at all, so
  // seeding one without it would produce a fixture the orchestrator refuses to load.
  await db.insert(taskRepository).values({
    workspaceId,
    taskId: row.id,
    repositoryId: repo.id,
    checkoutBranch: `solow/task-${row.id}`,
    position: 0,
  });
  console.log(JSON.stringify({ id: row.id, title: row.title }));
}

/**
 * The two Workspaces every spec here assumes.
 *
 * This used to be `db:seed`, back when the product shipped a two-company fixture and the E2E
 * suite borrowed it. That fixture is gone — a real install now starts with one empty Workspace —
 * so the second tenant, which exists purely so the isolation suite can prove a Task cannot reach
 * across a Workspace boundary (Principle V), belongs to the tests that need it rather than to
 * the thing users install.
 *
 * The repositories are deliberately not created here: every spec connects its own through the
 * UI, which is part of what it is testing.
 */
async function seedTenants(): Promise<void> {
  const db = createDb();
  // The first one is the product's own bootstrap, at the id dev-owner mode binds to — so the
  // suite exercises the same starting state a real local install has.
  await bootstrapWorkspace(db, { name: "E2E workspace", ownerUserId: "local-owner" });

  await db
    .insert(workspace)
    .values({ id: OTHER_WORKSPACE, name: "E2E other tenant", ownerUserId: "other-owner" })
    .onConflictDoNothing();
  await ensureDefaultAgentCatalog(db, OTHER_WORKSPACE);
  console.log(JSON.stringify({ tenants: [LOCAL_WORKSPACE, OTHER_WORKSPACE] }));
}

/** Kept in step with `e2e/support/fixture.ts`, which cannot import `@solow/db` (Node runner). */
const LOCAL_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";

const [, , kind, workspaceId, ...rest] = process.argv;
if (kind !== "tenants" && (!workspaceId || rest.length === 0)) {
  console.error("usage: seed-cli.ts tenants");
  console.error("       seed-cli.ts issue <workspaceId> <repoName|-> <title…>");
  console.error("       seed-cli.ts task <workspaceId> <title…>");
  process.exit(1);
}
// The repository name rides ahead of the title because the title may hold spaces: everything
// after the fixed positions is the title, and nothing has to be quoted twice.
if (kind === "tenants") {
  await seedTenants();
} else if (!workspaceId) {
  // Narrowed here rather than in the guard above: `tenants` takes no Workspace, so the guard
  // cannot demand one for every command.
  console.error("seed-cli: a workspaceId is required for this command");
  process.exit(1);
} else if (kind === "issue") {
  const [repoName, ...titleParts] = rest;
  await seedIssue(workspaceId, repoName ?? "-", titleParts.join(" "));
} else if (kind === "task") {
  await seedTask(workspaceId, rest.join(" "));
} else {
  console.error(`unknown kind: ${kind}`);
  process.exit(1);
}
