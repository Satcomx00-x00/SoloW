"use client";

import type { RunLinkDto, TaskEvent } from "@solow/contracts";
import { runLinksIn } from "@solow/core";
import {
  CircleDot,
  CirclePlay,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  type LucideIcon,
  Tag,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Where the run went outside this app: one door per thing it did (`sessionRunLinks`).
 *
 * The merge request a harness opens and the pipeline it starts are the two facts about a run
 * that live somewhere else entirely, and until now the only record of either was a URL inside a
 * `<pre>` a few hundred tool calls up the transcript. A reviewer who wanted to look at the MR
 * scrolled for it and copied it out by hand. These are the same URLs, read out of the same log,
 * in the rail beside everything else that is true about the Task.
 *
 * Doors, not status. Nothing here says whether the pipeline passed or the MR was merged — this
 * build asks no provider anything, and a button that implied a state it had not checked would be
 * worse than one that only promises to take you there. The provider's own page is the answer.
 */

/**
 * Whether a frame that has just arrived names a link the list does not have yet.
 *
 * The list itself comes from the server, over the whole log (`sessionRunLinks`), and
 * `session.get` is refetched on a status or a diff — neither of which a `glab mr create`
 * produces. So a run that opens an MR at minute two would show nothing here until it ended.
 *
 * This is the live half, and it is deliberately a *trigger* rather than a second derivation:
 * the frame is scanned once as it goes past, and a URL nobody has seen before refetches the
 * Session. One rule for what a link is, on the server, and no client-side list to disagree with
 * it — and no rescan of the whole live buffer on every frame of output, which is what deriving
 * the list here again would have cost.
 *
 * `seen` is the caller's, and is added to: the same MR is printed by every subsequent
 * `glab mr view`, and each of those must not refetch.
 */
export function noticesNewRunLink(event: TaskEvent, seen: Set<string>): boolean {
  // The live counterpart of `sessionRunLinks`' evidence rule: what a tool printed, what it was
  // asked to run, what the model said, what the machinery said. Never the operator's own turn.
  const text =
    event.kind === "tool_result"
      ? event.output
      : event.kind === "tool_use"
        ? Object.values(event.input ?? {}).join("\n")
        : event.kind === "stdout" && (event.channel === "assistant" || event.channel === "system")
          ? event.text
          : null;
  let novel = false;
  for (const link of runLinksIn(text)) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    novel = true;
  }
  return novel;
}

const ICON: Record<RunLinkDto["kind"], LucideIcon> = {
  merge_request: GitPullRequest,
  pipeline: CirclePlay,
  commit: GitCommitHorizontal,
  release: Tag,
  issue: CircleDot,
};

export function RunLinks({ links }: { links: readonly RunLinkDto[] }) {
  if (links.length === 0) {
    // A real answer, not an empty box: most runs open nothing, and "opened nothing" is what a
    // reviewer needs to read before going looking for an MR that was never created.
    return (
      <p className="text-muted-foreground text-xs">
        The run opened nothing outside this app — no merge request, no pipeline.
      </p>
    );
  }
  // One repository is the ordinary case and naming it on every row would be noise. A Task can
  // attach several, though — and then "Merge request !42" and "Merge request !7" say nothing
  // about which repository either is in, which is the whole question.
  const origins = new Set(links.map((link) => `${link.host}/${link.repository ?? ""}`));
  return (
    <ul className="space-y-1">
      {links.map((link) => {
        const Icon = ICON[link.kind];
        return (
          <li key={link.url}>
            <Button
              asChild
              variant="outline"
              size="sm"
              // Full width and left-aligned: these are rows in a column, and a row of pills in a
              // 400px rail wraps into a shape nobody can scan.
              className="w-full justify-start gap-2 font-normal"
            >
              <a href={link.url} target="_blank" rel="noreferrer" data-run-link={link.kind}>
                <Icon aria-hidden className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-left">{link.label}</span>
                {origins.size > 1 ? (
                  // The repository, or the instance when the URL named no repository at all.
                  <span className="max-w-[45%] shrink-0 truncate font-mono text-2xs text-muted-foreground">
                    {link.repository ?? link.host}
                  </span>
                ) : null}
                <ExternalLink aria-hidden className="shrink-0 text-muted-foreground" />
              </a>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
