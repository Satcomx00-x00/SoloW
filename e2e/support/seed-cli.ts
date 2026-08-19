/// <reference types="bun-types" />
/**
 * E2E fixture seeding, run as a `bun` subprocess (issue #15).
 *
 * The Playwright test runner itself is Node, not Bun (see the note this replaces in
 * `isolation.spec.ts`), so a spec file cannot import `@gatecontrol/db` directly — that package
 * reaches `bun:sqlite`. Every other place this suite needs the database from outside a browser
 * page already solves this by shelling out to a `bun run` subprocess (`prepareFixture`'s
 * `db:migrate`/`db:seed`); this is the same pattern for the two things a spec needs mid-run:
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
  createDb,
  encryptSecret,
  executorProfile,
  issue,
  repository,
  secret,
  task,
} from "@gatecontrol/db";

async function seedIssue(workspaceId: string, title: string): Promise<void> {
  const db = createDb();
  const [row] = await db.insert(issue).values({ workspaceId, title }).returning();
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

  const [agent] = await db
    .insert(agentProfile)
    .values({
      workspaceId,
      name: `e2e-agent-${suffix}`,
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
      repositoryId: repo.id,
    })
    .returning();
  if (!row) throw new Error("failed to seed task");
  console.log(JSON.stringify({ id: row.id, title: row.title }));
}

const [, , kind, workspaceId, ...titleParts] = process.argv;
const title = titleParts.join(" ");
if (!workspaceId || !title) {
  console.error("usage: seed-cli.ts <issue|task> <workspaceId> <title>");
  process.exit(1);
}
if (kind === "issue") await seedIssue(workspaceId, title);
else if (kind === "task") await seedTask(workspaceId, title);
else {
  console.error(`unknown kind: ${kind}`);
  process.exit(1);
}
