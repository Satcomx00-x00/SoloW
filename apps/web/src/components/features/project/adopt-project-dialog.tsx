"use client";

import type { AdoptProjectResultDto } from "@solow/contracts";
import { Loader2, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/trpc/react";

/**
 * What the search box matches on.
 *
 * Title *and* owner, because on an account with several organizations the distinguishing word is
 * as often the owner as the project's own name — typing "acme" to reach acme's Roadmap is the
 * obvious move, and a title-only filter answers it with nothing.
 *
 * Matching is case-insensitive on every whitespace-separated word, so "acme road" finds
 * "Roadmap" under "acme" whichever order they were typed in.
 */
export function matches(
  candidate: { title: string; ownerLogin: string | null; provider: string },
  query: string,
): boolean {
  const haystack =
    `${candidate.title} ${candidate.ownerLogin ?? ""} ${candidate.provider}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * Adopting a project (issue #126).
 *
 * SoloW never creates a project on its provider — it mirrors one that already exists
 * (Decision 0018, Out of scope). So this dialog is the whole of setup: what can your token see,
 * and which of those do you want to follow.
 *
 * A project already mirrored stays listed, disabled. Hiding it would make the picker look like
 * the provider has fewer projects than it does, which is the same question answered wrongly.
 */
export function AdoptProjectDialog({ onAdopted }: { onAdopted: (projectId: string) => void }) {
  const [open, setOpen] = useState(false);
  /**
   * What the import did, kept on screen after it finishes.
   *
   * The dialog stays open on success rather than closing, because on GitLab the import *wrote to
   * the operator's repository* — creating the scoped labels a project needs to exist — and it did
   * so without a confirmation step. Closing on success would make that the one thing they never
   * see.
   */
  const [report, setReport] = useState<AdoptProjectResultDto | null>(null);
  /** The filter, not persisted: a picker reopened is a fresh question. */
  const [query, setQuery] = useState("");
  const utils = trpc.useUtils();
  const available = trpc.project.available.useQuery({}, { enabled: open });
  const visible = useMemo(
    () => (available.data ?? []).filter((c) => matches(c, query)),
    [available.data, query],
  );
  const adopt = trpc.project.adopt.useMutation({
    onSuccess: (result) => {
      void utils.project.list.invalidate();
      setReport(result);
      onAdopted(result.project.id);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reopening with the last search still applied would show a short list and no reason for
        // it — the same empty-looking picker the search is meant to prevent.
        if (!next) setQuery("");
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Adopt a project
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Adopt a project</DialogTitle>
          <DialogDescription>
            Projects your connected tokens can see. SoloW mirrors one that already exists — create a
            new one in your provider&apos;s own interface.
          </DialogDescription>
        </DialogHeader>

        {available.isPending ? (
          <p className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
            <Loader2 aria-hidden className="size-4 animate-spin" /> Asking your providers…
          </p>
        ) : (available.data ?? []).length === 0 ? (
          <p className="py-6 text-muted-foreground text-sm">
            {/* Two different causes, and the operator can act on neither without being told. */}
            No projects found. Either no connected integration supports projects, the token has no
            access to one, or — for organization projects — it is missing the{" "}
            <code className="font-mono">read:org</code> scope, which GitHub reports as an empty list
            rather than as an error.
          </p>
        ) : (
          <>
            <div className="relative">
              <Label htmlFor="adopt-search" className="sr-only">
                Search projects
              </Label>
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/70"
              />
              <Input
                id="adopt-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Project or owner"
                className="h-8 pl-8 text-sm"
              />
            </div>
            {visible.length === 0 ? (
              // Distinct from "no projects found": the token can see projects, this search just
              // does not name one. Saying so keeps a typo from reading as a missing scope.
              <p className="py-6 text-muted-foreground text-sm">
                No project matches “{query}”. {available.data?.length ?? 0} available.
              </p>
            ) : (
              <ul className="max-h-80 divide-y overflow-y-auto">
                {visible.map((candidate) => (
                  <li
                    key={`${candidate.integrationId}:${candidate.externalId}`}
                    className="flex items-center gap-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{candidate.title}</span>
                      <span className="block truncate font-mono text-2xs text-muted-foreground">
                        {/* Owner first: on a company account most projects are an organization's, and
                        two orgs with a "Roadmap" are one row twice without it. */}
                        {candidate.ownerLogin
                          ? `${candidate.ownerLogin} · ${candidate.provider}`
                          : candidate.provider}
                      </span>
                    </span>
                    <Button
                      size="xs"
                      variant={candidate.adopted ? "ghost" : "default"}
                      disabled={candidate.adopted || adopt.isPending}
                      onClick={() =>
                        adopt.mutate({
                          integrationId: candidate.integrationId,
                          providerProjectId: candidate.externalId,
                          title: candidate.title,
                        })
                      }
                    >
                      {candidate.adopted ? "Already followed" : "Adopt"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {report && (
          <div className="space-y-1.5 rounded-lg border bg-background/60 p-3 text-2xs">
            <p className="font-medium text-sm">Imported {report.project.title}</p>
            <p className="text-muted-foreground">
              {report.issues.imported} issue{report.issues.imported === 1 ? "" : "s"} from{" "}
              {report.issues.repositories} repositor
              {report.issues.repositories === 1 ? "y" : "ies"} · {report.rows.items} row
              {report.rows.items === 1 ? "" : "s"} over {report.rows.pages} page
              {report.rows.pages === 1 ? "" : "s"}
              {report.rows.skipped > 0 && ` · ${report.rows.skipped} still waiting on their issues`}
            </p>
            {report.rows.connected.length > 0 && (
              // Repositories connected on the operator's behalf. Named individually for the same
              // reason the created labels are: a write into their world that they never see is
              // the one kind they cannot undo.
              <p className="text-state-parked">
                Connected {report.rows.connected.join(", ")} — the repositories this project's
                issues live in.
              </p>
            )}
            {(report.rows.drafts > 0 || report.rows.pullRequests > 0) && (
              <p className="text-muted-foreground/70">
                Not shown:{" "}
                {[
                  report.rows.drafts > 0 &&
                    `${report.rows.drafts} draft${report.rows.drafts === 1 ? "" : "s"}`,
                  report.rows.pullRequests > 0 &&
                    `${report.rows.pullRequests} pull request${report.rows.pullRequests === 1 ? "" : "s"}`,
                ]
                  .filter(Boolean)
                  .join(" and ")}{" "}
                — every row here is an issue.
              </p>
            )}
            {report.structure.created.length > 0 && (
              // The part that was written into their repository. Named individually, because
              // "created 11 labels" is not something anyone can check.
              <p className="text-state-parked">
                Created on the provider: {report.structure.created.join(", ")}
              </p>
            )}
            {report.structure.existing.length > 0 && (
              <p className="text-muted-foreground/70">
                Left untouched: {report.structure.existing.length} label
                {report.structure.existing.length === 1 ? "" : "s"} already there
              </p>
            )}
            <Button size="xs" variant="outline" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        )}

        {adopt.error && (
          <p className="text-2xs text-state-failed">
            {/* The provider's own refusal, not a generic failure: a token without project scope
                is a different problem from a project that vanished. */}
            {adopt.error.message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
