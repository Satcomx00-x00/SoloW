"use client";

import type { WorkflowDto } from "@solow/contracts";
import { Plus, Store, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { trpc } from "@/trpc/react";
import { WorkflowStoreDialog } from "./workflow-store-dialog";
import { ImportWorkflowDialog } from "./workflow-transfer";

/**
 * The three ways a pipeline comes into being — from scratch, from a file, from the store — as the
 * Workflows page's own header controls.
 *
 * They used to be a create form folded into the sidebar under the list, which made the sidebar the
 * one column in the app that read differently on one route. The sidebar is for going places; the
 * page that shows Workflows is where you make one.
 */
export function WorkflowCreateActions({ installed }: { installed: readonly WorkflowDto[] }) {
  return (
    <>
      <WorkflowStoreDialog
        installed={installed}
        trigger={
          <Button size="sm" type="button" variant="ghost">
            <Store aria-hidden />
            Store
          </Button>
        }
      />
      <ImportWorkflowDialog
        trigger={
          <Button size="sm" type="button" variant="ghost">
            <Upload aria-hidden />
            Import
          </Button>
        }
      />
      <NewWorkflowButton />
    </>
  );
}

/** A name, and the new pipeline opens on the canvas. */
function NewWorkflowButton() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const create = trpc.workflow.create.useMutation({
    onSuccess: (created) => {
      utils.workflow.list.invalidate();
      setName("");
      setOpen(false);
      router.push(`/workflows/${created.id}`);
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" type="button" variant="outline">
          <Plus aria-hidden />
          New workflow
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name });
          }}
        >
          <Label htmlFor="new-workflow-name">Workflow name</Label>
          <Input
            autoFocus
            className="h-8 text-sm"
            id="new-workflow-name"
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Plan, build, review"
            required
            value={name}
          />
          <Button className="w-full" disabled={!name || create.isPending} size="sm" type="submit">
            Create
          </Button>
          {create.error && (
            <p className="font-mono text-2xs text-state-failed" role="alert">
              {create.error.message}
            </p>
          )}
        </form>
      </PopoverContent>
    </Popover>
  );
}
