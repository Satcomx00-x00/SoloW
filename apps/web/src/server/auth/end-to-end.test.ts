/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import { getWorkspaceFlags } from "../dal/workspace.js";
import { appRouter } from "../routers/index.js";
import type { BaseContext } from "../trpc.js";
import { createAuth, workspaceForUser } from "./auth.js";
import { resolveSession } from "./session.js";

/**
 * The whole chain, unmocked (tasks TASK-011 / TASK-012): a real BetterAuth sign-up, the cookie a
 * browser would send back, session resolution, per-Workspace flag lookup, and the tRPC procedures
 * on the other side. The point is that the pieces verified separately actually fit — in
 * particular that `workspaceId` reaches the DAL from the session and from nowhere else.
 */

const OWNER = { email: "owner@gatecontrol.test", password: "correct-horse-battery", name: "Owner" };

beforeAll(() => {
  process.env["GATECONTROL_AUTH_SECRET"] ??= "test-auth-secret-at-least-32-characters";
  process.env["GATECONTROL_STREAM_SECRET"] ??= "test-stream-secret";
  process.env["GATECONTROL_WEB_URL"] ??= "http://localhost:5000";
  process.env["GATECONTROL_SECRET_KEY"] ??= Buffer.alloc(32, 7).toString("base64");
});

let db: TestDb;
let auth: ReturnType<typeof createAuth>;

beforeEach(() => {
  db = createTestDb();
  auth = createAuth(db);
});

/** What `createContext` does, wired to this test's database — session in, tRPC context out. */
async function contextFor(cookie: string): Promise<BaseContext> {
  const session = await resolveSession(new Headers({ cookie }), {
    db,
    getSession: (headers) => auth.api.getSession({ headers }),
  });
  if (!session) return { db, session: null };
  return { db, session, flagOverrides: await getWorkspaceFlags(db, session.workspaceId) };
}

async function signUpOwner(): Promise<{ cookie: string; userId: string }> {
  const response = await auth.api.signUpEmail({ body: OWNER, returnHeaders: true });
  return {
    cookie: response.headers.get("set-cookie") ?? "",
    userId: response.response.user.id,
  };
}

const enableCoreLoop = (workspaceId: string) =>
  db
    .update(workspace)
    .set({ enabledFlags: { "ff-core-program": true } })
    .where(eq(workspace.id, workspaceId));

/** Run a call and return the TRPCError code, or "OK" if it resolved. */
async function errCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

describe("signed-in Owner reaching the API", () => {
  it("is refused until the flag is switched on for their Workspace", async () => {
    const { cookie } = await signUpOwner();

    // The Owner is authenticated — this is the flag, not the session.
    const before = appRouter.createCaller(await contextFor(cookie));
    expect(await errCode(() => before.issue.list({}))).toBe("FORBIDDEN");
  });

  it("reads and writes its own Workspace once the flag is on", async () => {
    const { cookie, userId } = await signUpOwner();
    const workspaceId = (await workspaceForUser(db, userId)) as string;
    await enableCoreLoop(workspaceId);

    const caller = appRouter.createCaller(await contextFor(cookie));
    const created = await caller.issue.create({ title: "Gate servo stalls" });
    const listed = await caller.issue.list({});

    expect(listed.map((i) => i.id)).toEqual([created.id]);
  });

  it("writes land in the Workspace the session names, not one the client picked", async () => {
    const { cookie, userId } = await signUpOwner();
    const ownWorkspace = (await workspaceForUser(db, userId)) as string;
    await enableCoreLoop(ownWorkspace);
    // Another tenant that the signed-in Owner has nothing to do with.
    const [other] = await db
      .insert(workspace)
      .values({ name: "Someone else", ownerUserId: "another-user" })
      .returning();

    const caller = appRouter.createCaller(await contextFor(cookie));
    // The input schemas carry no `workspaceId` at all, so there is nothing to spoof — the row
    // can only be written where the session says.
    await caller.issue.create({ title: "Only mine" });

    const theirs = appRouter.createCaller({
      db,
      session: { workspaceId: (other as { id: string }).id, userId: "another-user" },
      flagOverrides: { "ff-core-program": true },
    });
    expect(await theirs.issue.list({})).toHaveLength(0);
  });

  it("is unauthorized with no cookie, before the flag is even consulted", async () => {
    await signUpOwner();
    const anonymous = appRouter.createCaller(await contextFor(""));
    expect(await errCode(() => anonymous.issue.list({}))).toBe("UNAUTHORIZED");
  });

  it("is unauthorized again after signing out", async () => {
    const { cookie, userId } = await signUpOwner();
    await enableCoreLoop((await workspaceForUser(db, userId)) as string);
    const signedIn = appRouter.createCaller(await contextFor(cookie));
    expect(await errCode(() => signedIn.issue.list({}))).toBe("OK");

    await auth.api.signOut({ headers: new Headers({ cookie }) });

    const after = appRouter.createCaller(await contextFor(cookie));
    expect(await errCode(() => after.issue.list({}))).toBe("UNAUTHORIZED");
  });

  it("clearing the flag is a kill switch on a live session", async () => {
    const { cookie, userId } = await signUpOwner();
    const workspaceId = (await workspaceForUser(db, userId)) as string;
    await enableCoreLoop(workspaceId);
    expect(
      await errCode(async () => appRouter.createCaller(await contextFor(cookie)).issue.list({})),
    ).toBe("OK");

    await db
      .update(workspace)
      .set({ enabledFlags: { "ff-core-program": false } })
      .where(eq(workspace.id, workspaceId));

    // The same still-valid session is refused on its next request — no sign-out needed.
    expect(
      await errCode(async () => appRouter.createCaller(await contextFor(cookie)).issue.list({})),
    ).toBe("FORBIDDEN");
  });
});
