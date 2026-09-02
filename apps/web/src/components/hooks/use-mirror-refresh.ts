"use client";

import type { TaskEvent } from "@solow/contracts";
import { useCallback } from "react";
import { useWorkspaceEvents } from "@/lib/workspace-events";
import { trpc } from "@/trpc/react";

/**
 * Re-read mirrored rows when the poll says they moved — the client half of `sync/announce.ts`.
 *
 * This is what lets every screen here read from cache and still be current. The rows a project
 * table draws are a mirror of a provider polled in the background, so a screen has two ways to
 * notice a change: ask again on a timer, or be told. A timer is a request per open tab per
 * interval regardless of whether anything happened, and it is *still* stale for up to one
 * interval; being told costs one frame on a socket the app already opens, and only when the poll
 * actually wrote something.
 *
 * So there is no polling anywhere in this app. A tab sits on its cache, issues nothing, and
 * refreshes within a second of the mirror moving.
 *
 * Invalidation, never data: the frame says *what* changed, and the queries re-read it through
 * the API they already use. React Query refetches only the queries that are mounted — an
 * invalidated list nobody is looking at is marked stale and read on its next mount, so a
 * background announcement costs an idle tab nothing.
 */
export function useMirrorRefresh(): void {
  const utils = trpc.useUtils();

  const onEvent = useCallback(
    (event: TaskEvent) => {
      if (event.kind !== "mirror") return;
      if (event.scope === "labels") {
        // A label's colour, and nothing else. Kept separate from `issues` precisely so a
        // six-hourly vocabulary refresh does not re-read every issue list in every open tab.
        void utils.issue.labelColors.invalidate();
        return;
      }
      /*
       * Everything a poll's issue write can be showing through.
       *
       * `project.allItems` as well as `issue.list`, because a newly imported Issue joins the
       * local Projects its Repository is registered under — the row appears in the project
       * table, not only in the issue list. `issue.get` because a detail panel left open on an
       * Issue the provider just closed would otherwise keep claiming it is open.
       */
      void utils.issue.list.invalidate();
      void utils.project.allItems.invalidate();
      void utils.issue.get.invalidate();
    },
    [utils],
  );

  useWorkspaceEvents(onEvent);
}
