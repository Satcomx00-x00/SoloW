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
 * Rejecting a review discards the agent's worktree, stopping an agent ends a run, and dragging a
 * Task out of Review on the board abandons the work without recording a decision — none of these
 * has an undo, so none may be one click. They go through one component so the wording, the
 * `alertdialog` semantics and the keyboard behaviour (focus on Cancel, Escape cancels) are the
 * same wherever the user meets them.
 */

export interface ConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

/** Controlled variant — for a confirmation raised by something other than a button press. */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel,
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
        <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
