"use client";

import type {
  CreatedEpicDto,
  CreatedProviderIssueDto,
  ParentPlanningContainer,
} from "@solow/contracts";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";
import { formatDate, isoToday, parseDateInput } from "./date-input";

/**
 * Flow B of the create workflow (spec F23a Parts 1 and 3): originate the **parent planning item**
 * a provider nests its work items under.
 *
 * It comes in two shapes, and this dialog asks the *manifest* which one it is looking at rather
 * than the provider's name (Decision 0016). A `"group"` container is GitLab's epic: a separate
 * object, in a group, with dates of its own. A `"repository"` container is GitHub's parent issue:
 * an ordinary issue whose parent-ness is entirely the sub-issue edges its children later draw to
 * it. `container` decides what the "Where" step collects and which fields Compose can honestly
 * offer; `noun` decides what the whole thing is called, because "New epic" is untrue of a provider
 * that has no epics.
 *
 * Same two-modal shape and same single-source-of-state rule as `create-issue-dialog.tsx`: "Where"
 * picks the container, "Compose" fills it in, and ← Back is a `setStep` because nothing typed is
 * held inside a step.
 */

/**
 * A date field's contribution to the request, honouring the three-state rule of `createEpicInput`
 * (`undefined` = leave GitLab's default, `null` = clear a fixed date, a string = fix it). An
 * untouched field must send `undefined` — collapsing it to `null` would clear the date GitLab would
 * otherwise compute from the epic's milestones, which is a change nobody asked for.
 *
 * Still named for the epic, deliberately: it is about an epic's three-state dates, and those exist
 * only on the group container. Nothing on the repository branch calls it.
 */
export function epicDateValue(
  text: string,
  touched: boolean,
  today: string,
): string | null | undefined {
  if (!touched) return undefined;
  if (text.trim() === "") return null;
  return parseDateInput(text, today);
}

type Step = "where" | "compose";

export function CreateParentItemDialog({
  projectId,
  integrationId,
  container,
  noun,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  integrationId: string;
  /** Where this provider's parent item is created — the manifest's answer, not a guess. */
  container: ParentPlanningContainer;
  /** The provider's own word for it, lowercase: "epic", "parent issue". */
  noun: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (created: CreatedEpicDto | CreatedProviderIssueDto) => void;
}) {
  const utils = trpc.useUtils();
  const today = useMemo(() => isoToday(new Date()), []);
  const inGroup = container === "group";

  // Each query is enabled only for its own container, so a repository-container provider — whose
  // driver throws on `listGroups` — is never asked for groups it does not have.
  const groups = trpc.project.listGroups.useQuery({ integrationId }, { enabled: open && inGroup });
  const repos = trpc.repository.list.useQuery({ ...WHOLE_PAGE }, { enabled: open && !inGroup });
  /**
   * Only repositories on the connection the gate approved.
   *
   * Tighter than `CreateIssueDialog`'s `integrationId !== null`, and deliberately: an Issue may be
   * created on any provider-backed repository, but a parent planning item is only valid where a
   * manifest declared *this* container shape — a repository on another connection could be on a
   * provider whose parent lives in a group, and the DAL would refuse it after the form was filled.
   */
  const eligible = useMemo(
    () => (repos.data?.items ?? []).filter((r) => r.integrationId === integrationId),
    [repos.data, integrationId],
  );

  const [step, setStep] = useState<Step>("where");
  const [groupRef, setGroupRef] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [tagText, setTagText] = useState("");
  // Text buffers plus a "touched" flag each, because the flag is the only thing that tells an
  // untouched field (send nothing) apart from one a person cleared on purpose (send null).
  const [startText, setStartText] = useState("");
  const [startTouched, setStartTouched] = useState(false);
  const [dueText, setDueText] = useState("");
  const [dueTouched, setDueTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep("where");
    setGroupRef("");
    setRepositoryId("");
    setTitle("");
    setDescription("");
    setLabels([]);
    setTagText("");
    setStartText("");
    setStartTouched(false);
    setDueText("");
    setDueTouched(false);
  }, [open]);

  // Skip Modal 1 when only one container is reachable (F23a Flow B) — the same rule on both
  // branches, because "one choice is not a question" is a fact about the operator, not about
  // which provider they are on.
  useEffect(() => {
    if (!open || !inGroup || groupRef) return;
    const only = groups.data?.length === 1 ? groups.data[0] : undefined;
    if (only) {
      setGroupRef(only.fullPath);
      setStep("compose");
    }
  }, [open, inGroup, groups.data, groupRef]);
  useEffect(() => {
    if (!open || inGroup || repositoryId) return;
    const only = eligible.length === 1 ? eligible[0] : undefined;
    if (only) {
      setRepositoryId(only.id);
      setStep("compose");
    }
  }, [open, inGroup, eligible, repositoryId]);

  const createEpic = trpc.project.createEpic.useMutation({
    onSuccess: (created) => {
      // The epic is inserted as a parent row on the next read of the project's items (F23a Action
      // 5), so that is what is invalidated — never a locally built row.
      void utils.project.allItems.invalidate();
      onCreated?.(created);
      onOpenChange(false);
    },
  });
  const createParent = trpc.issue.createParentOnProvider.useMutation({
    onSuccess: (created) => {
      // Unlike the epic, this one really lands as an `issue` row and as a row in this Project, so
      // both reads are invalidated — the same pair `CreateIssueDialog` invalidates, for the same
      // reason: what appears is the mirrored copy, never a locally patched one.
      void utils.project.allItems.invalidate();
      void utils.issue.list.invalidate();
      onCreated?.(created);
      onOpenChange(false);
    },
  });
  const pending = inGroup ? createEpic.isPending : createParent.isPending;
  const error = inGroup ? createEpic.error : createParent.error;

  const addTag = () => {
    const value = tagText.trim();
    if (value && !labels.includes(value)) setLabels((prev) => [...prev, value]);
    setTagText("");
  };
  const removeTag = (value: string) => setLabels((prev) => prev.filter((l) => l !== value));

  const startDate = epicDateValue(startText, startTouched, today);
  const dueDate = epicDateValue(dueText, dueTouched, today);

  const chosen = inGroup ? groupRef : repositoryId;
  const canSubmit = title.trim().length > 0 && chosen.length > 0;

  const submit = () => {
    if (!canSubmit) return;
    const common = {
      projectId,
      title,
      ...(description.trim().length > 0 ? { description } : {}),
      ...(labels.length > 0 ? { labels } : {}),
    };
    if (inGroup) {
      createEpic.mutate({
        integrationId,
        groupRef,
        ...common,
        // Only sent when touched — an absent key is "leave the provider's default", which is not the
        // same request as `null`.
        ...(startDate !== undefined ? { startDate } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
      });
      return;
    }
    createParent.mutate({ repositoryId, ...common });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        {step === "where" ? (
          <>
            <DialogHeader>
              <DialogTitle>New {noun} · where</DialogTitle>
              <DialogDescription>
                {inGroup
                  ? "Pick the group to create the epic in. Epics are a group object on GitLab, not a project one."
                  : `Pick the repository to create the ${noun} in. Other issues nest under it there.`}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label>{inGroup ? "Group" : "Repository"}</Label>
              {inGroup ? (
                groups.isPending ? (
                  <p className="text-muted-foreground text-sm">Loading groups…</p>
                ) : (groups.data ?? []).length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No group this token can create an epic in.
                  </p>
                ) : (
                  <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
                    {(groups.data ?? []).map((g) => (
                      <li key={g.externalId}>
                        <button
                          type="button"
                          className={`flex w-full flex-col px-3 py-2 text-left hover:bg-muted/60 ${
                            g.fullPath === groupRef ? "bg-muted/60" : ""
                          }`}
                          onClick={() => setGroupRef(g.fullPath)}
                        >
                          <span className="truncate text-sm">{g.name}</span>
                          <span className="truncate font-mono text-2xs text-muted-foreground">
                            {g.fullPath}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : repos.isPending ? (
                <p className="text-muted-foreground text-sm">Loading repositories…</p>
              ) : eligible.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {/* Says which list came back empty and why, because the filter is narrower than
                      the Issue flow's: a repository on another connection is not a broken row. */}
                  No repository on this connection. Connect one to it first.
                </p>
              ) : (
                <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
                  {eligible.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className={`flex w-full flex-col px-3 py-2 text-left hover:bg-muted/60 ${
                          r.id === repositoryId ? "bg-muted/60" : ""
                        }`}
                        onClick={() => setRepositoryId(r.id)}
                      >
                        <span className="truncate text-sm">{r.name}</span>
                        {r.externalFullName && (
                          <span className="truncate font-mono text-2xs text-muted-foreground">
                            {r.externalFullName}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={chosen.length === 0}
                onClick={() => setStep("compose")}
              >
                Next →
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New {noun} · compose</DialogTitle>
              <DialogDescription>
                What comes back is the provider&apos;s own copy, never the text typed here.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="create-epic-title">Title</Label>
                <Input
                  id="create-epic-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Cold-weather reliability"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="create-epic-description">Description</Label>
                <Textarea
                  id="create-epic-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional. Markdown."
                />
              </div>

              <div className="grid gap-2">
                <Label>Labels</Label>
                {/* Free text, not a checkbox list: there is no group-label query in the router the
                    way `repository.listLabels` serves the Issue flow, so a `project.listGroupLabels`
                    is what a picker here would need. Typed labels still reach the provider. */}
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      value={tagText}
                      onChange={(e) => setTagText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addTag();
                        }
                      }}
                      placeholder="Type a label and press Enter"
                      aria-label="New label"
                    />
                    <Button type="button" variant="outline" onClick={addTag}>
                      Add
                    </Button>
                  </div>
                  {labels.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {labels.map((l) => (
                        <Badge key={l} variant="secondary" className="gap-1">
                          {l}
                          <button
                            type="button"
                            aria-label={`Remove label ${l}`}
                            onClick={() => removeTag(l)}
                            className="rounded-full hover:text-destructive"
                          >
                            <X className="size-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Dates are drawn only for the group container: an item in a repository container is
                  an issue, and whether an issue carries a due date is `issueCreates.dueDate`, which
                  the provider behind this branch declares false. A control is drawn only where the
                  provider can hold what it collects. */}
              {inGroup && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="create-epic-start">Start date</Label>
                    <Input
                      id="create-epic-start"
                      value={startText}
                      onChange={(e) => {
                        setStartText(e.target.value);
                        setStartTouched(true);
                      }}
                      placeholder="today, +2w, 2026-09-01"
                    />
                    {typeof startDate === "string" && (
                      <p className="text-muted-foreground text-2xs">{formatDate(startDate)}</p>
                    )}
                    {startTouched && startText.trim() !== "" && startDate === null && (
                      <p className="text-destructive text-2xs">Not a date SoloW recognises.</p>
                    )}
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="create-epic-due">Due date</Label>
                    <Input
                      id="create-epic-due"
                      value={dueText}
                      onChange={(e) => {
                        setDueText(e.target.value);
                        setDueTouched(true);
                      }}
                      placeholder="+1m, 2026-12-31"
                    />
                    {typeof dueDate === "string" && (
                      <p className="text-muted-foreground text-2xs">{formatDate(dueDate)}</p>
                    )}
                    {dueTouched && dueText.trim() !== "" && dueDate === null && (
                      <p className="text-destructive text-2xs">Not a date SoloW recognises.</p>
                    )}
                  </div>
                </div>
              )}

              {error && (
                <p className="text-destructive text-sm" role="alert">
                  {/* The provider's own refusal, kept with the form intact (F23a error rule). */}
                  {error.message}
                </p>
              )}
            </div>
            <DialogFooter>
              {(inGroup ? (groups.data ?? []).length : eligible.length) > 1 && (
                <Button type="button" variant="ghost" onClick={() => setStep("where")}>
                  ← Back
                </Button>
              )}
              <Button type="button" disabled={!canSubmit} loading={pending} onClick={submit}>
                Create {noun}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
