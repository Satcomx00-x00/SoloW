/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { agentCatalog, authSchema, workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import { createAuth, ownerExists, workspaceForUser } from "./auth.js";
import { resolveSession } from "./session.js";

/**
 * Auth wiring (task TASK-011). These run the *real* BetterAuth instance against a real (in
 * memory, migrated) database — no mock of the thing being tested. What they pin down is the
 * security shape the rest of the app assumes: one Owner, a Workspace that exists from the
 * moment the Owner does, and a `workspaceId` that only ever comes from the signed session.
 */

const OWNER = { email: "owner@gatecontrol.test", password: "correct-horse-battery", name: "Owner" };

beforeAll(() => {
  process.env["GATECONTROL_AUTH_SECRET"] ??= "test-auth-secret-at-least-32-characters";
  process.env["GATECONTROL_STREAM_SECRET"] ??= "test-stream-secret";
  process.env["GATECONTROL_WEB_URL"] ??= "http://localhost:5000";
});

let db: TestDb;
let auth: ReturnType<typeof createAuth>;

beforeEach(() => {
  db = createTestDb();
  auth = createAuth(db);
});

/** Sign up the Owner and return the `set-cookie` the browser would keep. */
async function signUpOwner(): Promise<{ cookie: string; userId: string }> {
  const response = await auth.api.signUpEmail({ body: OWNER, returnHeaders: true });
  const cookie = response.headers.get("set-cookie") ?? "";
  return { cookie, userId: response.response.user.id };
}

/** The headers a browser would send back with that cookie. */
const withCookie = (cookie: string) => new Headers({ cookie });

describe("owner account creation", () => {
  it("creates the Owner and their Workspace together", async () => {
    expect(await ownerExists(db)).toBe(false);

    const { userId } = await signUpOwner();

    expect(await ownerExists(db)).toBe(true);
    // The Workspace must exist by the time the first request resolves — otherwise session
    // resolution would have to create one, making a read path write (Principle V).
    const workspaceId = await workspaceForUser(db, userId);
    expect(workspaceId).toBeTruthy();
  });

  it("refuses a second account — an instance has exactly one Owner", async () => {
    await signUpOwner();

    // Left open, anyone who can reach the port could create an account on someone else's
    // machine and read the Workspace that holds their agent credentials.
    await expect(
      auth.api.signUpEmail({
        body: { email: "intruder@example.test", password: "another-long-password", name: "X" },
      }),
    ).rejects.toThrow();

    const users = await db.select().from(authSchema.authUser);
    expect(users).toHaveLength(1);
  });

  it("starts a new Workspace with every flag off", async () => {
    const { userId } = await signUpOwner();
    const [row] = await db
      .select()
      .from(workspace)
      .where(eq(workspace.ownerUserId, userId))
      .limit(1);
    // Signing up must not switch the core loop on — flags are an operator decision.
    expect(row?.enabledFlags ?? null).toBeNull();
  });

  it("rejects a password below the minimum length", async () => {
    await expect(
      auth.api.signUpEmail({ body: { email: "o@test.test", password: "short", name: "O" } }),
    ).rejects.toThrow();
    expect(await ownerExists(db)).toBe(false);
  });
});

describe("resolveSession", () => {
  /** Session resolution wired to this test's auth instance and database. */
  const deps = () => ({
    db,
    getSession: (headers: Headers) => auth.api.getSession({ headers }),
  });

  it("resolves the Owner's identity and Workspace from a signed session", async () => {
    const { cookie, userId } = await signUpOwner();

    const resolved = await resolveSession(withCookie(cookie), deps());
    expect(resolved).toEqual({ userId, workspaceId: (await workspaceForUser(db, userId)) ?? "" });
  });

  it("returns null with no cookie at all", async () => {
    await signUpOwner();
    expect(await resolveSession(new Headers(), deps())).toBeNull();
  });

  it("returns null for a forged session token", async () => {
    await signUpOwner();
    const forged = withCookie("better-auth.session_token=not-a-real-token");
    expect(await resolveSession(forged, deps())).toBeNull();
  });

  it("returns null after signing out", async () => {
    const { cookie } = await signUpOwner();
    expect(await resolveSession(withCookie(cookie), deps())).not.toBeNull();

    await auth.api.signOut({ headers: withCookie(cookie) });
    expect(await resolveSession(withCookie(cookie), deps())).toBeNull();
  });

  it("refuses a user with no Workspace rather than a session without a tenant key", async () => {
    const { cookie, userId } = await signUpOwner();
    // Sign-up also seeds the Workspace's default agent catalog row (issue #10); delete it first
    // so the Workspace delete below isn't rejected by its own foreign key.
    const [ws] = await db.select().from(workspace).where(eq(workspace.ownerUserId, userId));
    if (ws) await db.delete(agentCatalog).where(eq(agentCatalog.workspaceId, ws.id));
    await db.delete(workspace).where(eq(workspace.ownerUserId, userId));

    // Half a session is worse than none: `workspaceId` would then have to come from somewhere
    // other than the session, which is exactly what Principle V forbids.
    expect(await resolveSession(withCookie(cookie), deps())).toBeNull();
  });

  it("signs in an existing Owner and resolves the same Workspace", async () => {
    const { userId } = await signUpOwner();
    const signedIn = await auth.api.signInEmail({
      body: { email: OWNER.email, password: OWNER.password },
      returnHeaders: true,
    });

    const resolved = await resolveSession(
      withCookie(signedIn.headers.get("set-cookie") ?? ""),
      deps(),
    );
    expect(resolved?.userId).toBe(userId);
    expect(resolved?.workspaceId).toBe((await workspaceForUser(db, userId)) ?? "");
  });

  it("does not accept the wrong password", async () => {
    await signUpOwner();
    await expect(
      auth.api.signInEmail({ body: { email: OWNER.email, password: "wrong-password-entirely" } }),
    ).rejects.toThrow();
  });
});

describe("credential storage", () => {
  it("never stores the password as given", async () => {
    await signUpOwner();
    const [account] = await db.select().from(authSchema.authAccount);
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toContain(OWNER.password);
  });
});
