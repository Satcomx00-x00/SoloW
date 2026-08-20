"use client";

import type { IssueDto } from "@gatecontrol/contracts";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
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
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/trpc/react";

/**
 * Create or edit an Issue (issue #15 reversal, 2026-08-20) — one dialog for both, mode inferred
 * from whether `issue` is passed. Opened from the Board's Backlog column, not a page navigation.
 *
 * The label control branches on the selected Repository, not on a toggle the user sets: a
 * Repository linked to a GitHub/GitLab Integration already has real labels, so retyping them
 * would just invite a typo that never matches the provider's own tag — the checkbox list fetches
 * those. A local-path Repository has nothing to fetch, so free text is the only option there.
 *
 * Editing an imported (non-`"local"`) Issue disables title/description, mirroring the DAL's
 * refusal (`IssueErrorCode.SourceOwned`, spec F01 FR-3) exactly, so the form never offers an
 * edit the server will reject. Labels stay editable regardless of source.
 */
export function IssueFormDialog({
  issue,
  trigger,
  onSuccess,
}: {
  issue?: IssueDto;
  trigger: ReactNode;
  onSuccess?: () => void;
}) {
  const isEdit = issue !== undefined;
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const repos = trpc.repository.list.useQuery({}, { enabled: open });

  const [title, setTitle] = useState(issue?.title ?? "");
  const [description, setDescription] = useState(issue?.description ?? "");
  const [repositoryId, setRepositoryId] = useState(issue?.repositoryId ?? "");
  const [labels, setLabels] = useState<string[]>(issue?.labels ?? []);
  const [tagText, setTagText] = useState("");

  // Local state is seeded from `issue` once, at mount — reset it explicitly whenever the dialog
  // reopens, so a second open (create after a previous edit, or a different Issue) does not
  // inherit whatever was left over from the last time it was open.
  useEffect(() => {
    if (!open) return;
    setTitle(issue?.title ?? "");
    setDescription(issue?.description ?? "");
    setRepositoryId(issue?.repositoryId ?? "");
    setLabels(issue?.labels ?? []);
    setTagText("");
  }, [open, issue]);

  const selectedRepo = (repos.data ?? []).find((r) => r.id === repositoryId);
  const fetchesLabels = Boolean(selectedRepo?.integrationId);
  const providerLabels = trpc.repository.listLabels.useQuery(
    { repositoryId },
    { enabled: open && fetchesLabels && repositoryId.length > 0 },
  );

  // The server's own rule (spec F01 FR-3), mirrored here so the form never offers an edit the
  // DAL will refuse with ISSUE_SOURCE_OWNED.
  const fieldsLocked = isEdit && issue.source !== "local";

  const create = trpc.issue.create.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
      setOpen(false);
      onSuccess?.();
    },
  });
  const update = trpc.issue.update.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
      utils.issue.get.invalidate();
      setOpen(false);
      onSuccess?.();
    },
  });
  const mutation = isEdit ? update : create;

  const submit = () => {
    if (isEdit) {
      update.mutate({
        id: issue.id,
        // Omitted entirely, not sent empty, for a locked Issue: `updateIssueInput` treats an
        // absent field as "no change", which is what a disabled input must mean here.
        ...(fieldsLocked ? {} : { title, description }),
        labels,
      });
    } else {
      create.mutate({ title, description, repositoryId, labels });
    }
  };

  const toggleProviderLabel = (name: string) => {
    setLabels((prev) => (prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name]));
  };

  const addTag = () => {
    const value = tagText.trim();
    if (value && !labels.includes(value)) setLabels((prev) => [...prev, value]);
    setTagText("");
  };

  const removeTag = (value: string) => setLabels((prev) => prev.filter((l) => l !== value));

  const canSubmit = title.trim().length > 0 && (isEdit || repositoryId.length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit issue" : "New issue"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this issue's details and labels."
              : "Describe the work and pick the repository it belongs to."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="issue-title">Title</Label>
            <Input
              id="issue-title"
              value={title}
              disabled={fieldsLocked}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Gate motor stalls in cold weather"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="issue-description">Description</Label>
            <Textarea
              id="issue-description"
              value={description}
              disabled={fieldsLocked}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
          {fieldsLocked && (
            <p className="text-muted-foreground text-xs">
              Title and description come from {issue.source} and are not edited here — only labels
              are GateControl's to change.
            </p>
          )}
          <div className="grid gap-2">
            <Label htmlFor="issue-repository">Repository</Label>
            <Select value={repositoryId} onValueChange={setRepositoryId} disabled={isEdit}>
              <SelectTrigger className="w-full" id="issue-repository">
                <SelectValue placeholder="Select a repository" />
              </SelectTrigger>
              <SelectContent>
                {(repos.data ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isEdit && (
              <p className="text-muted-foreground text-xs">
                An issue's repository is fixed once created.
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label>Labels</Label>
            {fetchesLabels ? (
              <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border p-2">
                {providerLabels.isLoading ? (
                  <p className="text-muted-foreground text-xs">Fetching labels…</p>
                ) : providerLabels.isError ? (
                  // Distinct from the empty-repository case below: this repository may well have
                  // labels, we just couldn't read them (expired credential, provider rate-limit,
                  // a stale integrationId with ff-integrations off). Saying so plainly, with a way
                  // to retry, is what stops an Owner from reading a fetch failure as a confident
                  // "this repository has no labels".
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-destructive text-xs">
                      Couldn't load labels from the provider.
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => providerLabels.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (providerLabels.data ?? []).length === 0 ? (
                  <p className="text-muted-foreground text-xs">No labels on this repository yet.</p>
                ) : (
                  (providerLabels.data ?? []).map((l) => (
                    <label
                      key={l.name}
                      className="flex items-center gap-2 text-sm"
                      htmlFor={`issue-label-${l.name}`}
                    >
                      <Checkbox
                        id={`issue-label-${l.name}`}
                        checked={labels.includes(l.name)}
                        onCheckedChange={() => toggleProviderLabel(l.name)}
                      />
                      {l.color && (
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full border"
                          style={{ backgroundColor: l.color }}
                        />
                      )}
                      {l.name}
                    </label>
                  ))
                )}
              </div>
            ) : (
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
            )}
          </div>
          {mutation.error && (
            <p className="text-destructive text-sm" role="alert">
              {mutation.error.message}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" disabled={!canSubmit} loading={mutation.isPending} onClick={submit}>
            {isEdit ? "Save changes" : "Create issue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
