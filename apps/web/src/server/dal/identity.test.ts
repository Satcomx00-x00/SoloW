/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { matchesProjectFilter, parseProjectFilter } from "@gatecontrol/core";
import { integration, project } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import type { RequestContext } from "./context.js";
import {
  clearProviderIdentity,
  listProviderIdentities,
  providerIdentityForProject,
  setProviderIdentity,
} from "./identity.js";
import { seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Who `@me` is (spec F23 FR-11).
 *
 * The bug these tests exist for: `@me` used to be the GateControl account name, compared against
 * a provider login. Two different names for one person, agreeing by coincidence — so the tab the
 * whole saved-views feature is named after matched nothing in practice, and there was no way for
 * anyone to correct it.
 *
 * So the claims worth pinning are the ones that make the tab honest: a stated login resolves for
 * the person who stated it and for nobody else, an unstated one resolves to *nothing rather than
 * everything*, and neither can be read across a Workspace boundary (Principle V).
 */

let db: TestDb;
let acme: string;
let other: string;

const ctxFor = (workspaceId: string, userId: string): RequestContext => ({
  db,
  workspaceId,
  userId,
});

/**
 * An Integration and a Project on it — the chain `@me` is resolved along.
 *
 * No Secret row: nothing here decrypts a token, and seeding one would make these tests depend on
 * the encryption key being set by whichever other file in the run happens to set it.
 */
async function seedProjectOn(workspaceId: string, title = "Roadmap") {
  const [connected] = await db
    .insert(integration)
    .values({ workspaceId, provider: "github", secretId: `secret-${title}` })
    .returning();
  if (!connected) throw new Error("failed to seed integration");
  const [row] = await db
    .insert(project)
    .values({
      workspaceId,
      integrationId: connected.id,
      providerProjectId: `PVT_${title}`,
      title,
    })
    .returning();
  if (!row) throw new Error("failed to seed project");
  return { integrationId: connected.id, projectId: row.id };
}

beforeEach(async () => {
  db = createTestDb();
  acme = (await seedWorkspaceGraph(db, "acme")).workspaceId;
  other = (await seedWorkspaceGraph(db, "other")).workspaceId;
});

describe("setProviderIdentity", () => {
  it("stores the login for the session's user, not one named in the input", async () => {
    // Guards the tenancy rule: the person is a fact about the session (Principle V), so there is
    // no argument a client could send that would write somebody else's mapping.
    const { integrationId } = await seedProjectOn(acme);

    const saved = await setProviderIdentity(ctxFor(acme, "ada"), {
      integrationId,
      login: "ada-on-the-host",
    });

    expect(saved.ok).toBe(true);
    const mine = await listProviderIdentities(ctxFor(acme, "ada"));
    const theirs = await listProviderIdentities(ctxFor(acme, "grace"));
    if (mine.ok) expect(mine.data.map((i) => i.login)).toEqual(["ada-on-the-host"]);
    if (theirs.ok) expect(theirs.data).toEqual([]);
  });

  it("a correction replaces the previous answer instead of adding a second one", async () => {
    // Two rows for one connection would make `@me` resolve by insertion order, which is a filter
    // whose answer changes for no reason anyone can see.
    const { integrationId, projectId } = await seedProjectOn(acme);
    await setProviderIdentity(ctxFor(acme, "ada"), { integrationId, login: "typo" });

    await setProviderIdentity(ctxFor(acme, "ada"), { integrationId, login: "ada-on-the-host" });

    const listed = await listProviderIdentities(ctxFor(acme, "ada"));
    if (listed.ok) expect(listed.data).toHaveLength(1);
    const resolved = await providerIdentityForProject(ctxFor(acme, "ada"), { projectId });
    if (resolved.ok) expect(resolved.data.login).toBe("ada-on-the-host");
  });

  it("refuses an Integration belonging to another Workspace", async () => {
    // Otherwise a mapping could be written into a tenant the caller cannot read back — a row
    // nobody can see, against a connection that is not theirs.
    const elsewhere = await seedProjectOn(other);

    const attempted = await setProviderIdentity(ctxFor(acme, "ada"), {
      integrationId: elsewhere.integrationId,
      login: "ada",
    });

    expect(attempted.ok).toBe(false);
  });
});

describe("listProviderIdentities", () => {
  it("does not list a mapping whose Integration has been disconnected", async () => {
    // `integration_id` carries no foreign key, so a disconnect leaves the row behind. Listing it
    // would offer a login for a connection that no longer exists — and would hand it to whatever
    // Integration happened to reuse the id.
    const { integrationId } = await seedProjectOn(acme);
    await setProviderIdentity(ctxFor(acme, "ada"), { integrationId, login: "ada-on-the-host" });

    await db.delete(project);
    await db.delete(integration);

    const listed = await listProviderIdentities(ctxFor(acme, "ada"));
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data).toEqual([]);
  });
});

describe("clearProviderIdentity", () => {
  it("returns `@me` to unstated rather than to an empty login", async () => {
    // "Not stated" and "stated as nothing" have to stay one state, or the table would have two
    // ways of matching nothing and two things to explain.
    const { integrationId, projectId } = await seedProjectOn(acme);
    await setProviderIdentity(ctxFor(acme, "ada"), { integrationId, login: "ada-on-the-host" });

    const cleared = await clearProviderIdentity(ctxFor(acme, "ada"), { integrationId });

    expect(cleared.ok).toBe(true);
    const resolved = await providerIdentityForProject(ctxFor(acme, "ada"), { projectId });
    if (resolved.ok) expect(resolved.data.login).toBeNull();
  });
});

describe("providerIdentityForProject", () => {
  it("resolves the login stated for the Integration the Project belongs to", async () => {
    // The payoff: a project is one Integration's, so exactly one login can mean "me" on it.
    const { integrationId, projectId } = await seedProjectOn(acme);
    await setProviderIdentity(ctxFor(acme, "ada"), { integrationId, login: "ada-on-the-host" });

    const resolved = await providerIdentityForProject(ctxFor(acme, "ada"), { projectId });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.data.login).toBe("ada-on-the-host");
      expect(resolved.data.integrationId).toBe(integrationId);
    }
  });

  it("does not carry a login from one Integration onto another Integration's project", async () => {
    // The same person is a different login on a company host than on the public one, which is
    // why the mapping is per Integration rather than per provider id.
    const onGithub = await seedProjectOn(acme, "Public");
    const onEnterprise = await seedProjectOn(acme, "Internal");
    await setProviderIdentity(ctxFor(acme, "ada"), {
      integrationId: onGithub.integrationId,
      login: "ada-public",
    });

    const resolved = await providerIdentityForProject(ctxFor(acme, "ada"), {
      projectId: onEnterprise.projectId,
    });

    if (resolved.ok) expect(resolved.data.login).toBeNull();
  });

  it("answers null — not an error — when nobody has stated a login", async () => {
    // An ordinary state, and one the caller has to be able to *say*: `@me` resolved to nothing
    // looks exactly like a project with nothing assigned to you.
    const { projectId } = await seedProjectOn(acme);

    const resolved = await providerIdentityForProject(ctxFor(acme, "ada"), { projectId });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.data.login).toBeNull();
  });

  it("resolves per reader, so one shared tab is 'mine' for whoever opens it", async () => {
    // A saved view stores `@me` symbolically. If resolution were per view rather than per reader,
    // a shared `My items` tab would be one person's items for everybody.
    const { integrationId, projectId } = await seedProjectOn(acme);
    await setProviderIdentity(ctxFor(acme, "ada"), { integrationId, login: "ada-on-the-host" });
    await setProviderIdentity(ctxFor(acme, "grace"), { integrationId, login: "grace-on-the-host" });

    const forAda = await providerIdentityForProject(ctxFor(acme, "ada"), { projectId });
    const forGrace = await providerIdentityForProject(ctxFor(acme, "grace"), { projectId });

    if (forAda.ok) expect(forAda.data.login).toBe("ada-on-the-host");
    if (forGrace.ok) expect(forGrace.data.login).toBe("grace-on-the-host");
  });

  it("refuses a Project in another Workspace", async () => {
    const elsewhere = await seedProjectOn(other);

    const resolved = await providerIdentityForProject(ctxFor(acme, "ada"), {
      projectId: elsewhere.projectId,
    });

    expect(resolved.ok).toBe(false);
  });
});

describe("what the resolved login does to the filter", () => {
  const row = { title: "Fix the latch", fields: { assignee: ["ada-on-the-host"] } };

  it("matches the reader's own rows once the mapping is stated", async () => {
    const { integrationId, projectId } = await seedProjectOn(acme);
    await setProviderIdentity(ctxFor(acme, "ada"), { integrationId, login: "ada-on-the-host" });
    const resolved = await providerIdentityForProject(ctxFor(acme, "ada"), { projectId });

    const me = resolved.ok ? resolved.data.login : null;

    expect(matchesProjectFilter(parseProjectFilter("assignee:@me"), row, { me })).toBe(true);
  });

  it("matches NOTHING rather than everything when no mapping exists", async () => {
    // The direction that matters. A `My items` tab quietly showing the whole project is a worse
    // failure than one showing none of it, because nothing about it looks wrong.
    const { projectId } = await seedProjectOn(acme);
    const resolved = await providerIdentityForProject(ctxFor(acme, "ada"), { projectId });

    const me = resolved.ok ? resolved.data.login : null;

    expect(me).toBeNull();
    expect(matchesProjectFilter(parseProjectFilter("assignee:@me"), row, { me })).toBe(false);
  });

  it("does not match a GateControl account name that only looks like the login", async () => {
    // The original defect, stated as a test: the account is `ada`, the provider login is
    // `ada-on-the-host`, and passing the first as `@me` matches none of that person's rows.
    expect(matchesProjectFilter(parseProjectFilter("assignee:@me"), row, { me: "ada" })).toBe(
      false,
    );
  });
});
