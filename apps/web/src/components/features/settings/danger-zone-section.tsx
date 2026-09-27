"use client";

import type { WorkspaceResetScope } from "@solow/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { trpc } from "@/trpc/react";
import { SectionStatus, SettingsField, SettingsSection } from "./settings-shell";

/**
 * Emptying the database from Settings (spec F16).
 *
 * Two actions, because the two things people mean by "clean up the database" are different and
 * only one of them lets you carry on working afterwards — see `workspaceResetScopeSchema`.
 *
 * **Why a typed name and not a ConfirmDialog.** Every other destructive action in this app uses
 * `ConfirmAction`, and that is the right weight for deleting the one row you are looking at:
 * you can see what goes, and History keeps a Task for seven days (Decision 0025). This has
 * neither property — it removes rows you are not looking at, and nothing survives it. So the
 * gate is re-typing the Workspace's own name, which cannot be done by a mis-aimed click or a
 * held key, and which the *server* re-checks against the name it holds so a tab left open
 * across a rename is refused rather than honoured.
 *
 * The receipt is a toast rather than a redirect. The action's whole problem is that it leaves no
 * evidence of itself, and "Removed 412 rows across 14 tables" is the only account the Owner
 * gets; a page that silently emptied and re-rendered would be indistinguishable from one that
 * did nothing.
 */

interface ResetAction {
  scope: WorkspaceResetScope;
  title: string;
  button: string;
  blurb: string;
  keeps: string;
}

const ACTIONS: readonly ResetAction[] = [
  {
    scope: "work-data",
    title: "Reset work data",
    button: "Reset work data",
    blurb:
      "Removes every Project, Issue, Task, Session, transcript and review in this workspace, and the worktrees they created on disk.",
    keeps:
      "Keeps your repositories, harness and executor profiles, secrets, integrations, MCP servers, skills and preferences — so you can start work again straight away.",
  },
  {
    scope: "everything",
    title: "Factory reset",
    button: "Erase everything",
    blurb:
      "Removes the work data above and the setup behind it: repositories, harness and executor profiles, secrets, integrations, MCP servers, skills, tokens and your interface preferences.",
    keeps:
      "Keeps your account, the workspace itself and the list of harnesses this build knows how to run. Everything else is as it was on the first launch.",
  },
];

export function DangerZoneSection() {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const workspace = trpc.workspace.get.useQuery();
  const [open, setOpen] = useState<ResetAction | null>(null);
  const [typed, setTyped] = useState("");

  const reset = trpc.workspace.reset.useMutation({
    onSuccess: (receipt) => {
      setOpen(null);
      setTyped("");
      // Everything on screen is now describing rows that are gone.
      utils.invalidate();
      toast({
        title:
          receipt.rows === 0
            ? "There was nothing to remove"
            : `Removed ${receipt.rows.toLocaleString()} rows across ${receipt.removed.length} ${
                receipt.removed.length === 1 ? "table" : "tables"
              }`,
        description:
          receipt.worktrees.length > 0
            ? `${receipt.worktrees.length} worktree ${
                receipt.worktrees.length === 1 ? "directory is" : "directories are"
              } being removed from disk.`
            : undefined,
        tone: "ok",
      });
    },
  });

  const name = workspace.data?.name ?? "";
  const armed = typed.trim() === name.trim() && name.length > 0;

  const close = (next: boolean) => {
    if (next) return;
    setOpen(null);
    setTyped("");
    reset.reset();
  };

  return (
    <SettingsSection
      caption="Emptying this workspace. Both of these delete rows permanently — there is no undo, and nothing here goes through History."
      id="danger-zone"
      status={<SectionStatus tone="bad">No undo</SectionStatus>}
      title="Reset"
    >
      <ul className="-mx-1 divide-y">
        {ACTIONS.map((action) => (
          <li className="flex flex-wrap items-start gap-3 px-1 py-3.5" key={action.scope}>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium text-sm">{action.title}</p>
              <p className="text-muted-foreground text-sm">{action.blurb}</p>
              <p className="text-muted-foreground text-xs">{action.keeps}</p>
            </div>
            <Button
              className="shrink-0"
              disabled={!workspace.data}
              onClick={() => {
                setTyped("");
                reset.reset();
                setOpen(action);
              }}
              type="button"
              variant="destructive"
            >
              {action.button}
            </Button>
          </li>
        ))}
      </ul>

      <Dialog onOpenChange={close} open={open !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{open?.title}</DialogTitle>
            <DialogDescription>
              {open?.blurb} {open?.keeps}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <form
              id="reset-workspace"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (open && armed) reset.mutate({ scope: open.scope, confirmName: typed.trim() });
              }}
            >
              <SettingsField
                hint="The name has to match exactly. This is the only thing standing between a stray click and a workspace with no data in it."
                htmlFor="reset-confirm"
                label={`Type ${name} to confirm`}
              >
                <Input
                  autoComplete="off"
                  id="reset-confirm"
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={name}
                  value={typed}
                />
              </SettingsField>
            </form>
            {reset.error && (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {reset.error.message}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => close(false)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={!armed}
              form="reset-workspace"
              loading={reset.isPending}
              type="submit"
              variant="destructive"
            >
              {open?.button}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
