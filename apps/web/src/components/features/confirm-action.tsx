"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/**
 * Confirmation gate for an action that throws work away (task TASK-022).
 *
 * Rejecting a review discards the harness's worktree, stopping a harness ends a run, and dragging a
 * Task out of Review on the board abandons the work without recording a decision — none of these
 * has an undo, so none may be one click. They go through one component so the wording, the
 * `alertdialog` semantics and the keyboard behaviour (focus on Cancel, Escape cancels) are the
 * same wherever the user meets them.
 */

export interface ConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
  /**
   * What kind of confirmation this is, which decides what the confirm button looks like.
   *
   * `destructive` is the default because that is what this component is for — every existing call
   * site is discarding a worktree, deleting a credential or abandoning a run, and all of them used
   * to end on the near-white primary button, indistinguishable from "Save". The theme reserves
   * Alarm Red for irreversible actions; this is the seam that lets it reach them.
   *
   * `neutral` is for the handful of confirmations that only ask "are you sure you meant to?" about
   * something reversible, where red would be crying wolf.
   */
  tone?: "destructive" | "neutral" | undefined;
}

/** Controlled variant — for a confirmation raised by something other than a button press. */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel,
  tone,
}: ConfirmCopy & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <ConfirmBody
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        tone={tone}
        onConfirm={() => {
          onOpenChange(false);
          onConfirm();
        }}
      />
    </AlertDialog>
  );
}

/** Trigger variant — wraps the button that would otherwise perform the action directly. */
export function ConfirmAction({
  trigger,
  onConfirm,
  disabled = false,
  ...copy
}: ConfirmCopy & {
  /** The button that opens the confirmation. Rendered as the dialog's trigger. */
  trigger: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild disabled={disabled}>
        {trigger}
      </AlertDialogTrigger>
      <ConfirmBody
        {...copy}
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
      />
    </AlertDialog>
  );
}

function ConfirmBody({
  title,
  description,
  confirmLabel,
  tone = "destructive",
  onConfirm,
}: ConfirmCopy & { onConfirm: () => void }) {
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          variant={tone === "destructive" ? "destructive" : "default"}
          onClick={onConfirm}
        >
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
