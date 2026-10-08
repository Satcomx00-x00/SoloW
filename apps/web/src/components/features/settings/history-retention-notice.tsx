"use client";

import { Archive } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { settingsHref } from "@/lib/navigation";
import { trpc } from "@/trpc/react";

/**
 * The one-time question put to the Owner of a Workspace that existed before history retention
 * (Decision 0032 §4).
 *
 * Such a Workspace was left keeping every transcript rather than given the default window,
 * because a default applied on upgrade would have deleted a month of history on the first sweep,
 * before anyone saw the setting. This is where the Owner learns there is now a choice. It shows
 * until a window is saved; "Keep forever" saves the window it already has (null), which is the
 * answer "I have seen this and want everything kept".
 *
 * Shown in Settings above the picker and, with a link there, on History, where a person thinking
 * about old Tasks is likely to be. Renders nothing for any other Workspace.
 */
export function HistoryRetentionNotice({ linkToSettings = false }: { linkToSettings?: boolean }) {
  const utils = trpc.useUtils();
  const retention = trpc.workspace.historyRetention.useQuery();
  const keep = trpc.workspace.setHistoryRetention.useMutation({
    onSuccess: (next) => utils.workspace.historyRetention.setData(undefined, next),
  });

  const data = retention.data;
  if (!data?.notice) return null;

  return (
    <div
      aria-label="Choose how long to keep history"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
      role="status"
      data-retention-notice
    >
      <Archive aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-muted-foreground">
        This Workspace keeps every transcript until you choose how long finished Tasks keep theirs.
        Nothing has been removed.
      </p>
      <div className="flex items-center gap-2">
        {linkToSettings ? (
          <Link
            className="text-foreground text-xs underline underline-offset-2"
            href={settingsHref("history-retention")}
          >
            Choose a window
          </Link>
        ) : null}
        <Button
          loading={keep.isPending}
          onClick={() => keep.mutate({ days: null })}
          size="sm"
          variant="outline"
        >
          Keep forever
        </Button>
      </div>
      {keep.error ? (
        <p className="w-full text-destructive text-xs" role="alert">
          {keep.error.message}
        </p>
      ) : null}
    </div>
  );
}
