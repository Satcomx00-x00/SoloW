"use client";

import type { IssueDto } from "@solow/contracts";
import { Check, Loader2, Lock, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentMarkdown } from "@/components/features/task/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/trpc/react";

/**
 * An Issue's description: read as **markdown**, edited in place.
 *
 * It used to be one `whitespace-pre-wrap` paragraph, which is the wrong reading of the text every
 * time. An issue body is markdown wherever it was written — a checklist of acceptance criteria, a
 * fenced repro, a table of cases — and rendering it flat handed the reader raw `- [ ]` and pipe
 * characters to parse themselves. The panel on the project table already renders the same string
 * through `AgentMarkdown`; the same body showing as prose in one place and as source in another
 * was the part that read as a bug.
 *
 * Editing routes on who owns the text, which is the rule F01 FR-3 has always stated:
 *
 *  - a **local** Issue is SoloW's, so `issue.update` writes it here;
 *  - an **imported** Issue belongs to its provider, so the edit goes out through
 *    `issue.updateExternal` and the mirror is refreshed from whatever the provider answers.
 *
 * For the imported case the editor opens on the provider's *current* body, not on the mirror —
 * `issue.detail` is fetched only once Edit is pressed, so the page costs nothing extra to read.
 * A form seeded from the last poll opens on a description somebody changed an hour ago and saves
 * over it with neither party seeing a conflict, which is the failure this whole file exists to
 * avoid; it is also where `writes`/`cannot` come from, so a provider that will not accept a
 * description says so in place of the editor rather than at the end of a save.
 */
export function IssueBody({ issue }: { issue: IssueDto }) {
  const utils = trpc.useUtils();
  const imported = issue.source !== "local";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.description ?? "");

  /**
   * The provider's current body and what it will accept a change to — asked for only while the
   * editor is open. `enabled` is the whole point: this is four provider calls, and a page that
   * made them on every open would pay for an editor almost nobody opens.
   */
  const detail = trpc.issue.detail.useQuery(
    { issueId: issue.id },
    { enabled: editing && imported },
  );

  const onSaved = () => {
    setEditing(false);
    void utils.issue.get.invalidate({ id: issue.id });
    void utils.issue.list.invalidate();
  };
  const updateLocal = trpc.issue.update.useMutation({ onSuccess: onSaved });
  const updateExternal = trpc.issue.updateExternal.useMutation({
    onSuccess: () => {
      void utils.issue.detail.invalidate({ issueId: issue.id });
      onSaved();
    },
  });
  const saving = updateLocal.isPending || updateExternal.isPending;
  const error = updateLocal.error ?? updateExternal.error;

  /**
   * Seed the editor from whichever body is authoritative, and re-seed when it changes.
   *
   * For an imported Issue that is the provider's answer as it arrives, so the textarea starts
   * empty-but-loading and fills in with the truth rather than with the mirror's guess at it.
   */
  const source = imported ? detail.data?.description : issue.description;
  useEffect(() => {
    if (editing) setDraft(source ?? "");
  }, [editing, source]);

  const writable = !imported || (detail.data?.writes.includes("description") ?? false);
  const refusal = imported ? (detail.data?.cannot.description ?? null) : null;

  const save = () => {
    if (imported) updateExternal.mutate({ issueId: issue.id, description: draft });
    else updateLocal.mutate({ id: issue.id, description: draft });
  };

  if (!editing) {
    return (
      <div className="mt-3 space-y-1.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {issue.description ? (
              <AgentMarkdown text={issue.description} />
            ) : (
              <p className="text-muted-foreground text-sm italic">No description yet.</p>
            )}
          </div>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground"
            onClick={() => setEditing(true)}
          >
            <Pencil aria-hidden />
            {issue.description ? "Edit" : "Add one"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      {detail.isLoading && (
        <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <Loader2 aria-hidden className="size-3 animate-spin" />
          Reading the current description from {issue.source}…
        </p>
      )}

      {refusal && !writable ? (
        <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
          <Lock aria-hidden className="mt-px size-3 shrink-0" />
          {refusal}
        </p>
      ) : (
        <Textarea
          aria-label="Description"
          rows={14}
          value={draft}
          disabled={detail.isLoading || saving}
          onChange={(event) => setDraft(event.target.value)}
          className="font-mono text-xs"
        />
      )}

      {/* Markdown, said once where it is true. The reader below already sees it rendered; the
          person typing is the only one who needs telling that the backticks will become code. */}
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          loading={saving}
          disabled={!writable || detail.isLoading}
          onClick={save}
        >
          <Check aria-hidden />
          Save
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => {
            setEditing(false);
            updateLocal.reset();
            updateExternal.reset();
          }}
        >
          <X aria-hidden />
          Cancel
        </Button>
        <span className="ml-1 text-2xs text-muted-foreground">Markdown</span>
      </div>

      {(error || detail.error) && (
        <p className="font-mono text-2xs text-state-failed" role="alert">
          {(error ?? detail.error)?.message}
        </p>
      )}
    </div>
  );
}
