import { Archive } from "lucide-react";
import Link from "next/link";
import { settingsHref } from "@/lib/navigation";
import { relativeAge } from "@/lib/relative-time";

/**
 * Said over a Session whose transcript the retention sweep removed (Decision 0032).
 *
 * Without it, a long-finished Task opens on a terminal holding three state changes and a diff
 * with no patch — which reads as a run that said nothing, or as data lost to a fault. It is
 * neither: the Workspace's own rule removed it, and the rule is one click away. Muted rather
 * than in a feedback colour, because nothing here needs doing.
 */
export function TranscriptPrunedNotice({ at }: { at: string }) {
  return (
    <div
      className="mx-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-muted-foreground text-sm"
      role="status"
      data-transcript-pruned
    >
      <Archive aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        This run's transcript was removed by the Workspace's history retention ({relativeAge(at)}).
        Its state changes, decisions, review and token usage are kept, and the diff keeps its file
        list.
      </span>
      <Link
        className="text-foreground text-xs underline underline-offset-2"
        href={settingsHref("history-retention")}
      >
        History retention
      </Link>
    </div>
  );
}
