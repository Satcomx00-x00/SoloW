"use client";

import type { AttentionItemDto } from "@solow/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast";
import { attentionNotice } from "@/lib/run-health";
import { taskHref } from "@/lib/task-href";
import { useWorkspaceEvents } from "@/lib/workspace-events";
import { trpc } from "@/trpc/react";

/**
 * A notice when a run fails or gets stuck (FINDINGS F3), in the app and nowhere else — notices
 * outside it are Later (decision 0031).
 *
 * Driven by the "needs attention" list rather than by the frames themselves, because a frame
 * says only that a Task changed state: a stranded park is announced as `parked`, which is also
 * what an ordinary park says. So a frame is a reason to re-read the list, and a notice is a Task
 * that is on the list now and was not before. The list as first read is the baseline — opening
 * the app does not replay every failure already on the board.
 *
 * Two things re-read it: any `status` frame, and the moment the list itself says a Task would
 * join by the clock alone (`recheckInMs`). A run going quiet is not an event, so that moment is
 * the only signal there is, and waiting for it costs nothing in between.
 */

/** Past this many at once, one notice says how many rather than a stack of them. */
const NOTICE_EACH_UP_TO = 3;

/**
 * Past the server's delay before asking. The timer starts once the answer has arrived, already
 * later than the server's "now", so this only has to cover timer granularity.
 */
const RECHECK_MARGIN_MS = 250;

/** `setTimeout` holds a signed 32-bit delay; anything longer fires at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;

const keyOf = (item: AttentionItemDto) => `${item.taskId}:${item.cause}`;

export function AttentionNotices() {
  const utils = trpc.useUtils();
  const router = useRouter();
  const { toast } = useToast();
  const attention = trpc.health.attention.useQuery();
  const seen = useRef<Set<string> | null>(null);

  const reread = useCallback(() => void utils.health.attention.invalidate(), [utils]);
  useWorkspaceEvents(
    useCallback(
      (event) => {
        if (event.kind === "status") reread();
      },
      [reread],
    ),
  );

  // A delay measured on the server's clock, not an instant compared against this browser's: a
  // browser running ahead would re-read at once, get the same answer back, and never look again.
  // Re-armed on every answer (`dataUpdatedAt`), because an identical answer is the normal case
  // and is still a reason to look again later.
  const recheckInMs = attention.data?.recheckInMs ?? null;
  const answeredAt = attention.dataUpdatedAt;
  useEffect(() => {
    if (recheckInMs === null || answeredAt === 0) return;
    const delay = Math.min(recheckInMs + RECHECK_MARGIN_MS, MAX_DELAY_MS);
    const timer = setTimeout(reread, delay);
    return () => clearTimeout(timer);
  }, [recheckInMs, answeredAt, reread]);

  const items = attention.data?.items;
  useEffect(() => {
    if (!items) return;
    const previous = seen.current;
    seen.current = new Set(items.map(keyOf));
    if (!previous) return;

    const joined = items.filter((item) => !previous.has(keyOf(item)));
    if (joined.length === 0) return;
    if (joined.length > NOTICE_EACH_UP_TO) {
      toast({
        title: `${joined.length} runs need attention`,
        description: "They are listed under “need attention” on the status bar.",
        tone: joined.some((i) => i.kind === "failed") ? "error" : "caution",
      });
      return;
    }
    for (const item of joined) {
      const notice = attentionNotice(item);
      toast({
        ...notice,
        action: {
          label: "Open",
          onClick: () => router.push(taskHref({ id: item.taskId, state: item.state })),
        },
      });
    }
  }, [items, toast, router]);

  return null;
}
