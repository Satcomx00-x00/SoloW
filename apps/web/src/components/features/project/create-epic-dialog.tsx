"use client";

import type { CreatedEpicDto } from "@solow/contracts";
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
import { trpc } from "@/trpc/react";
import { formatDate, isoToday, parseDateInput } from "./date-input";

/**
 * Flow B of the create workflow (spec F23a Part 1): originate an **Epic** on a GitLab group.
 *
 * An epic is a group object with no local equivalent (`issue-create.ts` doc), so unlike the Issue
 * flow there is nothing to fall back to when the provider cannot make one — the caller only mounts
 * this dialog for a Project whose manifest declared `issueCreates.epics`, so `integrationId` here is
 * always a real GitLab connection.
 *
 * Same two-modal shape and same single-source-of-state rule as `create-issue-dialog.tsx`: "Where"
 * picks the group, "Compose epic" fills it in, and ← Back is a `setStep` because nothing typed is
 * held inside a step.
 */

/**
 * A date field's contribution to the request, honouring the three-state rule of `createEpicInput`
 * (`undefined` = leave GitLab's default, `null` = clear a fixed date, a string = fix it). An
 * untouched field must send `undefined` — collapsing it to `null` would clear the date GitLab would
 * otherwise compute from the epic's milestones, which is a change nobody asked for.
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

export function CreateEpicDialog({
  projectId,
  integrationId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  integrationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (created: CreatedEpicDto) => void;
}) {
  const utils = trpc.useUtils();
  const today = useMemo(() => isoToday(new Date()), []);
  const groups = trpc.project.listGroups.useQuery({ integrationId }, { enabled: open });

  const [step, setStep] = useState<Step>("where");
  const [groupRef, setGroupRef] = useState("");
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
    setTitle("");
    setDescription("");
    setLabels([]);
    setTagText("");
    setStartText("");
    setStartTouched(false);
    setDueText("");
    setDueTouched(false);
  }, [open]);

  // Skip Modal 1 when only one group is reachable (F23a Flow B).
  useEffect(() => {
    if (!open || groupRef) return;
    const only = groups.data?.length === 1 ? groups.data[0] : undefined;
    if (only) {
      setGroupRef(only.fullPath);
      setStep("compose");
    }
  }, [open, groups.data, groupRef]);

  const create = trpc.project.createEpic.useMutation({
    onSuccess: (created) => {
      // The epic is inserted as a parent row on the next read of the project's items (F23a Action
      // 5), so that is what is invalidated — never a locally built row.
      void utils.project.allItems.invalidate();
      onCreated?.(created);
      onOpenChange(false);
    },
  });

  const addTag = () => {
    const value = tagText.trim();
    if (value && !labels.includes(value)) setLabels((prev) => [...prev, value]);
    setTagText("");
  };
  const removeTag = (value: string) => setLabels((prev) => prev.filter((l) => l !== value));

  const startDate = epicDateValue(startText, startTouched, today);
  const dueDate = epicDateValue(dueText, dueTouched, today);

  const submit = () => {
    if (!groupRef || title.trim().length === 0) return;
    create.mutate({
      integrationId,
      groupRef,
      projectId,
      title,
      ...(description.trim().length > 0 ? { description } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      // Only sent when touched — an absent key is "leave the provider's default", which is not the
      // same request as `null`.
      ...(startDate !== undefined ? { startDate } : {}),
      ...(dueDate !== undefined ? { dueDate } : {}),
    });
  };

  const canSubmit = title.trim().length > 0 && groupRef.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        {step === "where" ? (
          <>
            <DialogHeader>
              <DialogTitle>New epic · where</DialogTitle>
              <DialogDescription>
                Pick the group to create the epic in. Epics are a group object on GitLab, not a
                project one.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label>Group</Label>
              {groups.isPending ? (
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
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={groupRef.length === 0}
                onClick={() => setStep("compose")}
              >
                Next →
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New epic · compose</DialogTitle>
              <DialogDescription>
                What comes back is the group&apos;s own copy, never the text typed here.
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

              {create.error && (
                <p className="text-destructive text-sm" role="alert">
                  {/* The group's own refusal, kept with the form intact (F23a error rule). */}
                  {create.error.message}
                </p>
              )}
            </div>
            <DialogFooter>
              {(groups.data ?? []).length > 1 && (
                <Button type="button" variant="ghost" onClick={() => setStep("where")}>
                  ← Back
                </Button>
              )}
              <Button
                type="button"
                disabled={!canSubmit}
                loading={create.isPending}
                onClick={submit}
              >
                Create epic
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
