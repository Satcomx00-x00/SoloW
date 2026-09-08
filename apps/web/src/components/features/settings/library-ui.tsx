"use client";

import { CommonErrorCode } from "@solow/contracts";
import type { LucideIcon } from "lucide-react";
import { Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useId } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/**
 * The chrome the two library sections share (spec F24), so an MCP server and a Skill read as
 * two entries in the same kind of list rather than as two pages that happen to sit together.
 *
 * A row is: an icon that says what kind of thing it is, the name and a badge for its flavour,
 * what it is for, the one line of detail that identifies it, and the Workspace-wide switch.
 * That switch is a Checkbox in a labelled pill, not a Switch primitive — none exists in
 * `components/ui` and issue #76 owns adding one (see flags-section.tsx) — but the pill lights
 * up when checked so the rows that reach every harness stand out in a list of ones that do not.
 */

/** What a library section says when its flag is off, or its list failed. */
export function LibraryQueryState({ error }: { error: { message: string } | null }) {
  if (!error) return null;
  if (error.message === CommonErrorCode.FlagDisabled) {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-muted-foreground text-sm leading-relaxed">
          Harness libraries are not enabled here. Feature flags ship off — enable it from the
          machine running this instance:
        </p>
        <pre className="w-fit rounded-lg border bg-card px-3 py-2 font-mono text-xs">
          bun run flag enable ff-agent-libraries
        </pre>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 text-sm" role="alert">
      <TriangleAlert className="mt-px size-4 shrink-0 text-feedback-error" aria-hidden />
      <p className="font-mono text-muted-foreground text-xs">{error.message}</p>
    </div>
  );
}

/** The Workspace-wide switch on a row: on, the item is loaded into every harness that runs. */
export function EveryHarnessToggle({
  name,
  checked,
  onChange,
}: {
  name: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div
      className={`flex shrink-0 items-center gap-2 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent/40 ${
        checked ? "border-primary/40 bg-primary/5 text-foreground" : "text-muted-foreground"
      }`}
    >
      <Checkbox
        id={id}
        aria-label={`Load ${name} in every harness`}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <Label htmlFor={id} className="cursor-pointer select-none font-normal text-xs">
        Every harness
      </Label>
    </div>
  );
}

export function LibraryRow({
  icon: Icon,
  name,
  flavour,
  description,
  detail,
  enabled,
  onEnabled,
  removeTitle,
  removeDescription,
  removeLabel,
  onRemove,
}: {
  icon: LucideIcon;
  name: string;
  flavour: string;
  description: string | null;
  detail: string | null;
  enabled: boolean;
  onEnabled: (on: boolean) => void;
  removeTitle: string;
  removeDescription: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-start gap-3 px-3 py-3">
      <span
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground"
        aria-hidden
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium font-mono text-sm">{name}</span>
          <Badge variant="outline" className="text-2xs uppercase">
            {flavour}
          </Badge>
        </div>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
        {detail && (
          <p className="truncate font-mono text-2xs text-muted-foreground/80" title={detail}>
            {detail}
          </p>
        )}
      </div>
      <EveryHarnessToggle name={name} checked={enabled} onChange={onEnabled} />
      <ConfirmAction
        title={removeTitle}
        description={removeDescription}
        confirmLabel={removeLabel}
        onConfirm={onRemove}
        trigger={
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${name}`}>
            <Trash2 aria-hidden />
          </Button>
        }
      />
    </li>
  );
}

/** A library with nothing in it yet: says what one is for, and offers the form. */
export function LibraryEmpty({
  icon: Icon,
  title,
  hint,
  action,
  onAdd,
  secondary,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  action: string;
  onAdd: () => void;
  /** Another way in, beside the form — the bulk import, for a library that can be filled from disk. */
  secondary?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card/40 px-4 py-8 text-center">
      <span
        className="flex size-10 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground"
        aria-hidden
      >
        <Icon className="size-5" />
      </span>
      <div className="space-y-1">
        <p className="font-medium text-sm">{title}</p>
        <p className="mx-auto max-w-sm text-muted-foreground text-xs leading-relaxed">{hint}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus aria-hidden />
          {action}
        </Button>
        {secondary}
      </div>
    </div>
  );
}

/**
 * The panel a new entry is typed into. Opened on request and closed again once the entry is
 * saved: the list is the page, and a form that is always open is the thing people scroll past
 * to reach it.
 */
export function LibraryForm({
  title,
  onSubmit,
  onCancel,
  children,
}: {
  title: string;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <form
      className="space-y-4 rounded-lg border bg-muted/20 p-4"
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">{title}</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onCancel}
        >
          <X aria-hidden />
        </Button>
      </div>
      {children}
    </form>
  );
}
