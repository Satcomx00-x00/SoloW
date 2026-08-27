"use client";

import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import { trpc } from "@/trpc/react";

/**
 * Creating a local Project (issue #15's reversal, applied to Projects — user request 2026-08-27).
 *
 * `AdoptProjectDialog` exists because there is something to pick from; this dialog exists for the
 * opposite case, so there is nothing to pick — no search, no provider round trip, no list. A
 * title is the entire decision, because membership is not decided here at all: it comes later,
 * from which Repositories get registered under the Project (`ProjectRepositoriesDialog`).
 */
export function CreateLocalProjectDialog({
  onCreated,
}: {
  onCreated: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const utils = trpc.useUtils();

  const create = trpc.project.createLocal.useMutation({
    onSuccess: (project) => {
      void utils.project.list.invalidate();
      setOpen(false);
      setTitle("");
      onCreated(project.id);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A dialog reopened after a failed attempt should not still be showing that failure —
        // the mutation's own error state clears with it since the mutation itself is remounted.
        if (!next) setTitle("");
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Create a project
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Create a project</DialogTitle>
          <DialogDescription>
            A container SoloW holds outright — nothing is mirrored from a provider. Register
            repositories under it afterwards to decide what belongs.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = title.trim();
            if (trimmed.length === 0) return;
            create.mutate({ title: trimmed });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="local-project-title">Project name</Label>
            <Input
              id="local-project-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Internal tooling"
              autoFocus
            />
          </div>

          {create.error && (
            <p className="mt-2 text-2xs text-state-failed">{create.error.message}</p>
          )}

          <DialogFooter className="mt-4">
            <Button type="submit" disabled={title.trim().length === 0 || create.isPending}>
              {create.isPending && <Loader2 aria-hidden className="animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
