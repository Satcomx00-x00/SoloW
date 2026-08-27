"use client";

import type { ExternalIssuePreviewDto } from "@solow/contracts";
import { Check, Download, Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WHOLE_PAGE } from "@/lib/paged";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/** The state filter's options. `all` is not a provider state, hence its own value. */
const STATE_FILTERS = [
  { value: "all", label: "All states" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
] as const;
type StateFilter = (typeof STATE_FILTERS)[number]["value"];

/**
 * Import Issues from a linked GitHub/GitLab repository (issue #15 AC-2). A repository shows up
 * here once it has been linked to an Integration in Settings → Integrations. This is the
 * provider-backed path; `IssueFormDialog` is the other one — the issue #15 reversal brought
 * back a free-text Issue form alongside this, for a locally created Issue with no provider
 * behind it (packages/contracts/src/issue.ts documents the reversal).
 *
 * A repository with a hundred open issues is the normal case, so the list is filterable rather
 * than merely scrollable: the search box and the state filter narrow it, and "select all" acts
 * on *what is visible*, which is the only reading of it that is not a trap.
 */
export function ImportIssuesDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  /** Omitted when the caller opens the dialog itself; the default button is used otherwise. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const utils = trpc.useUtils();
  const repos = trpc.repository.list.useQuery({ ...WHOLE_PAGE }, { enabled: open });
  const linkedRepos = (repos.data?.items ?? []).filter((r) => r.integrationId);
  const [repositoryId, setRepositoryId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  /** Closing must not leave a stale selection or filter for next time. */
  const setOpen = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setSearch("");
      setStateFilter("all");
    }
    if (onOpenChange) onOpenChange(next);
    else setInternalOpen(next);
  };

  useEffect(() => {
    if (!repositoryId && linkedRepos[0]) setRepositoryId(linkedRepos[0].id);
  }, [repositoryId, linkedRepos]);

  const external = trpc.integration.listExternalIssues.useQuery(
    { repositoryId },
    { enabled: open && repositoryId.length > 0 },
  );

  const importIssues = trpc.integration.importIssues.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
      // An imported Issue arrives with the provider's labels on it, so the filter's vocabulary
      // has just grown.
      utils.issue.labels.invalidate();
      setOpen(false);
    },
  });

  /**
   * Switching repositories must drop the previous selection — the checked externalIds are only
   * meaningful within the repository that produced them, and importIssues sends whatever is
   * still checked to *this* repositoryId regardless of which repository the user meant it for
   * (adversarial review, pre-merge).
   */
  const changeRepository = (id: string) => {
    setRepositoryId(id);
    setSelected(new Set());
    setSearch("");
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const all = useMemo(() => external.data ?? [], [external.data]);

  /** What the filters leave on screen — the list, the counts and select-all all read this. */
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((i: ExternalIssuePreviewDto) => {
      if (stateFilter !== "all" && i.state !== stateFilter) return false;
      if (!needle) return true;
      return i.title.toLowerCase().includes(needle) || String(i.number).includes(needle);
    });
  }, [all, search, stateFilter]);

  // Only what is both visible and not already in SoloW can be acted on, so that is what
  // "select all" toggles against — offering to select rows whose checkbox is disabled would
  // produce a count the Import button then refuses to honour.
  const selectable = visible.filter((i) => !i.alreadyImported);
  const allVisibleSelected =
    selectable.length > 0 && selectable.every((i) => selected.has(i.externalId));

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const i of selectable) next.delete(i.externalId);
      else for (const i of selectable) next.add(i.externalId);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger === undefined ? (
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground hover:text-foreground"
          >
            <Download /> Import issues
          </Button>
        </DialogTrigger>
      ) : trigger === null ? null : (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      )}
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Import issues</DialogTitle>
          <DialogDescription>
            Pull issues from a connected GitHub or GitLab repository into SoloW.
          </DialogDescription>
        </DialogHeader>

        {repos.isSuccess && linkedRepos.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No repository is linked to an integration yet. Connect GitHub or GitLab and link a
            repository in Settings → Integrations first.
          </p>
        )}

        {linkedRepos.length > 0 && (
          <>
            {/* One row of controls, not three labelled fields stacked over the list: this is a
                toolbar for the list below it, and giving each control a heading made the
                filters heavier than the thing they filter (user report: "bad proportions").
                The labels stay for a screen reader, where the placeholder alone is thinner
                evidence than a name.

                Widths are apportioned to what each control holds rather than split evenly: a
                repository reads "name · owner/name" and needs the room, the search box holds a
                word, and the state filter holds one of three fixed strings. `min-w-0` on the
                first two is what lets them shrink instead of pushing the row wider than the
                dialog (see `SelectTrigger`, which carries the same for the same reason). */}
            <div className="flex shrink-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="import-repo" className="sr-only">
                  Repository
                </Label>
                <Select value={repositoryId} onValueChange={changeRepository}>
                  <SelectTrigger className="min-w-0 flex-[1.6]" id="import-repo">
                    <SelectValue placeholder="Select a repository" />
                  </SelectTrigger>
                  <SelectContent>
                    {linkedRepos.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name} · {r.externalFullName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Label htmlFor="import-search" className="sr-only">
                  Search
                </Label>
                <div className="relative min-w-0 flex-1">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/70"
                    aria-hidden
                  />
                  <Input
                    id="import-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Title or #number"
                    className="pl-8"
                  />
                </div>

                <Label htmlFor="import-state" className="sr-only">
                  State
                </Label>
                <Select value={stateFilter} onValueChange={(v) => setStateFilter(v as StateFilter)}>
                  <SelectTrigger className="w-28 shrink-0" id="import-state">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATE_FILTERS.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {external.isSuccess && (
                <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
                  <span className="tabular-nums">
                    {visible.length} of {all.length} issue{all.length === 1 ? "" : "s"}
                    {selected.size > 0 ? ` · ${selected.size} selected` : ""}
                  </span>
                  {/* Hidden rather than disabled at zero: "Select all 0" is not an offer, and a
                      row of chrome that can only say no is worse than no row. */}
                  {selectable.length > 0 && (
                    <Button type="button" size="xs" variant="ghost" onClick={toggleAllVisible}>
                      {allVisibleSelected ? "Clear selection" : `Select all ${selectable.length}`}
                    </Button>
                  )}
                </div>
              )}
            </div>

            {external.isSuccess && (
              <DialogBody className="rounded-lg border">
                <ul className="divide-y">
                  {visible.map((i) => {
                    const checked = selected.has(i.externalId);
                    return (
                      <li key={i.externalId}>
                        {/* The whole row is the hit target, not just the 16px checkbox —
                              picking twenty issues out of a list is the actual task here.
                              Radix renders the checkbox as a <button>, which a browser will not
                              forward a label click to on its own, so the row toggles explicitly
                              — and bows out when the click already landed on the control, which
                              handles itself and keeps working from the keyboard. */}
                        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the checkbox this
                              label is bound to is the keyboard control — it is focusable and
                              toggles on Space. This handler adds a pointer-only affordance on
                              top of it, so a key handler here would duplicate, not enable. */}
                        <label
                          htmlFor={`import-issue-${i.externalId}`}
                          onClick={(event) => {
                            if (i.alreadyImported) return;
                            if ((event.target as HTMLElement).closest('[role="checkbox"]')) return;
                            toggle(i.externalId);
                          }}
                          className={cn(
                            // One line per issue, in columns: the number, the title, then the
                            // state. Two-line rows put the state under the title, which read
                            // as eight paragraphs rather than a list you scan — and doubled
                            // the height of the only part of this dialog that matters.
                            "flex h-11 cursor-pointer items-center gap-3 px-3 transition-colors duration-100",
                            i.alreadyImported ? "cursor-default opacity-60" : "hover:bg-accent/40",
                            checked && "bg-accent/30",
                          )}
                        >
                          <Checkbox
                            id={`import-issue-${i.externalId}`}
                            checked={checked}
                            disabled={i.alreadyImported}
                            onCheckedChange={() => toggle(i.externalId)}
                            aria-label={`Import ${i.title}`}
                          />
                          {/* Right-aligned in a minimum-width column: every title starts at the
                              same x whatever the number's length, and the number stays beside
                              the title it belongs to instead of adrift from it. `min-w-`, not
                              `w-`, so a five-digit issue number is not clipped. */}
                          <span className="min-w-10 shrink-0 text-right font-mono text-muted-foreground text-xs tabular-nums">
                            #{i.number}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">{i.title}</span>
                          <span className="shrink-0 text-2xs text-muted-foreground capitalize">
                            {i.state}
                          </span>
                          {i.alreadyImported && (
                            <Badge variant="secondary" className="shrink-0 gap-1 px-1.5 text-2xs">
                              <Check className="size-3" aria-hidden /> Imported
                            </Badge>
                          )}
                        </label>
                      </li>
                    );
                  })}
                  {visible.length === 0 && (
                    <li className="p-6 text-center text-muted-foreground text-sm">
                      {all.length === 0
                        ? "No open issues found on this repository."
                        : "No issues match these filters."}
                    </li>
                  )}
                </ul>
              </DialogBody>
            )}

            {importIssues.error && (
              <p className="shrink-0 text-destructive text-sm" role="alert">
                {importIssues.error.message}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                loading={importIssues.isPending}
                disabled={selected.size === 0}
                onClick={() =>
                  importIssues.mutate({ repositoryId, externalIds: Array.from(selected) })
                }
              >
                Import selected ({selected.size})
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
