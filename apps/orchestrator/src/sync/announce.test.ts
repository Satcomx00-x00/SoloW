/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { TaskEvent } from "@solow/contracts";
import { taskEventSchema } from "@solow/contracts";
import { type MirrorAudience, MirrorChanges } from "./announce.js";

/**
 * What a poll tells open screens (see `announce.ts`).
 *
 * The assertion that carries the design is the negative one: a pass that changed nothing must
 * announce nothing. An announcement per pass regardless would be the polling this replaces, with
 * an extra hop.
 */

function recorder(): MirrorAudience & { sent: Array<{ channel: string; event: TaskEvent }> } {
  const sent: Array<{ channel: string; event: TaskEvent }> = [];
  return {
    sent,
    boardChannel: (workspaceId) => `ws:${workspaceId}`,
    publish: (channel, event) => {
      sent.push({ channel, event });
    },
  };
}

const at = () => new Date("2026-09-01T12:00:00.000Z");

describe("MirrorChanges", () => {
  it("says nothing when a pass changed nothing", () => {
    const hub = recorder();
    const changes = new MirrorChanges();

    expect(changes.empty).toBe(true);
    expect(changes.announce(hub, at)).toBe(0);
    expect(hub.sent).toHaveLength(0);
  });

  it("announces once per Workspace, however many repositories changed in it", () => {
    const hub = recorder();
    const changes = new MirrorChanges();
    changes.issuesChanged("ws-1");
    changes.issuesChanged("ws-1");
    changes.issuesChanged("ws-1");

    expect(changes.announce(hub, at)).toBe(1);
    expect(hub.sent).toEqual([
      {
        channel: "ws:ws-1",
        event: { kind: "mirror", scope: "issues", at: "2026-09-01T12:00:00.000Z" },
      },
    ]);
  });

  it("keeps the two scopes apart", () => {
    const hub = recorder();
    const changes = new MirrorChanges();
    changes.issuesChanged("ws-1");
    changes.labelsChanged("ws-1");

    expect(changes.announce(hub, at)).toBe(2);
    // Collapsing them would make a six-hourly vocabulary refresh re-read every issue list in
    // every open tab — the cost the whole mechanism exists to avoid.
    expect(hub.sent.map((s) => s.event.kind === "mirror" && s.event.scope)).toEqual([
      "issues",
      "labels",
    ]);
  });

  it("never crosses Workspaces", () => {
    const hub = recorder();
    const changes = new MirrorChanges();
    changes.issuesChanged("ws-1");
    changes.issuesChanged("ws-2");

    changes.announce(hub, at);

    expect(hub.sent.map((s) => s.channel).sort()).toEqual(["ws:ws-1", "ws:ws-2"]);
  });

  it("publishes a frame the client's own parser accepts", () => {
    const hub = recorder();
    const changes = new MirrorChanges();
    changes.labelsChanged("ws-1");
    changes.announce(hub, at);

    // The SPA drops any frame that fails this parse, silently — a shape that is merely
    // plausible here and invalid there would be a feature that quietly never works.
    expect(taskEventSchema.safeParse(hub.sent[0]?.event).success).toBe(true);
  });
});
