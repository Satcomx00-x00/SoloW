"use client";

import type { IssueDetailDto, IssueField } from "@gatecontrol/contracts";
import {
  CircleCheck,
  CircleDot,
  ExternalLink,
  Loader2,
  Lock,
  Plus,
  Tag,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { trpc } from "@/trpc/react";

/**
 * The issue panel — where an imported Issue is edited (spec F23 FR-13, Decision 0019).
 *
 * Read **live from the provider** when it opens, not from the mirror. A form built from the last
 * poll opens on a title someone else changed an hour ago and saves over it with neither party
 * seeing a conflict; a form built from the provider's current answer at least starts from the
 * truth, and every save re-reads it.
 *
 * Nothing here is optimistic. A field shows the provider's value until the provider's answer to
 * the write arrives, and then it shows that. The alternative — showing what was typed — is the
 * one failure a mirror must never have, because it looks exactly like success.
 *
 * A field the provider cannot hold is a value with the provider's own sentence attached, never a
 * disabled box: "GitLab weights need a paid tier" is actionable, a greyed input is not.
 */

function canWrite(detail: IssueDetailDto | undefined, field: IssueField): boolean {
  return detail?.writes.includes(field) ?? false;
}

/** The sentence to show where a control would have been, or nothing when there is none. */
function reasonFor(detail: IssueDetailDto | undefined, field: IssueField): string | null {
  return detail?.cannot[field] ?? null;
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground/70">
      <Lock aria-hidden className="size-3" />
      {reason}
    </span>
  );
}

function Person({
  login,
  name,
  avatarUrl,
}: {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Avatar className="size-5">
        {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
        <AvatarFallback className="text-[9px] uppercase">{login.slice(0, 2)}</AvatarFallback>
      </Avatar>
      <span className="truncate text-xs">{name ?? login}</span>
    </span>
  );
}

export function IssuePanel({
  issueId,
  onOpenChange,
}: {
  /** Null closes the panel. One prop rather than two, so "open" and "which" cannot disagree. */
  issueId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const detail = trpc.issue.detail.useQuery(
    { issueId: issueId ?? "" },
    { enabled: issueId !== null },
  );
  const update = trpc.issue.updateExternal.useMutation({
    onSuccess: () => {
      // The row on the table behind carries the same title and state.
      void utils.project.items.invalidate();
      void utils.issue.list.invalidate();
      void utils.issue.detail.invalidate();
    },
  });

  const data = detail.data;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Reset from the provider's answer whenever it changes — including after a save, which is how
  // a normalised title makes it onto the screen instead of the one that was typed.
  useEffect(() => {
    setTitle(data?.title ?? "");
    setDescription(data?.description ?? "");
  }, [data?.title, data?.description]);

  /** The patch minus the id, which every caller here shares and none should have to repeat. */
  type Patch = Omit<Parameters<typeof update.mutate>[0], "issueId">;
  const save = (patch: Patch) => {
    if (!issueId) return;
    update.mutate({ ...patch, issueId });
  };

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <TooltipProvider>
      <Sheet open={issueId !== null} onOpenChange={onOpenChange}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="gap-1 border-b">
            <SheetTitle className="text-sm">
              {data ? `#${data.externalNumber}` : "Issue"}
              {update.isPending && (
                <Loader2 aria-hidden className="ml-2 inline size-3 animate-spin align-middle" />
              )}
            </SheetTitle>
            <SheetDescription className="text-2xs">
              Edited on the provider that owns it. Every value here is what the provider answered,
              never what was typed.
            </SheetDescription>
          </SheetHeader>

          {detail.isPending && issueId !== null ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-7 w-3/4" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          ) : detail.error ? (
            <p className="p-4 text-2xs text-state-failed">{detail.error.message}</p>
          ) : data ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              <div className="space-y-1.5">
                <Label htmlFor="issue-title" className="text-2xs text-muted-foreground">
                  Title
                </Label>
                {canWrite(data, "title") ? (
                  <Input
                    id="issue-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    onBlur={() => title !== data.title && title.trim() && save({ title })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        setTitle(data.title);
                        event.currentTarget.blur();
                      }
                    }}
                    className="font-medium"
                  />
                ) : (
                  <>
                    <p className="font-medium text-sm">{data.title}</p>
                    {reasonFor(data, "title") && <Unavailable reason={reasonFor(data, "title")!} />}
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {canWrite(data, "state") ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={update.isPending}
                    onClick={() => save({ state: data.state === "open" ? "closed" : "open" })}
                  >
                    {data.state === "open" ? (
                      <>
                        <CircleCheck aria-hidden /> Close issue
                      </>
                    ) : (
                      <>
                        <CircleDot aria-hidden /> Reopen issue
                      </>
                    )}
                  </Button>
                ) : (
                  <Badge variant="outline">{data.state}</Badge>
                )}
                <a
                  href={data.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:underline"
                >
                  <ExternalLink aria-hidden className="size-3" /> Open on the provider
                </a>
              </div>

              <Separator />

              <div className="space-y-1.5">
                <Label htmlFor="issue-body" className="text-2xs text-muted-foreground">
                  Description
                </Label>
                {canWrite(data, "description") ? (
                  <Textarea
                    id="issue-body"
                    rows={8}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    onBlur={() => description !== (data.description ?? "") && save({ description })}
                    className="text-xs"
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-muted-foreground text-xs">
                    {data.description || "No description."}
                  </p>
                )}
              </div>

              <Separator />

              <Field
                icon={<Users aria-hidden className="size-3.5" />}
                label="Assignees"
                reason={reasonFor(data, "assignees")}
                editable={canWrite(data, "assignees")}
                trigger={
                  data.assignees.length === 0 ? (
                    <span className="text-2xs text-muted-foreground/60">Nobody</span>
                  ) : (
                    <span className="flex flex-wrap gap-2">
                      {data.assignees.map((u) => (
                        <Person key={u.login} {...u} />
                      ))}
                    </span>
                  )
                }
                options={data.availableAssignees.map((u) => ({
                  key: u.login,
                  label: u.name ? `${u.name} (${u.login})` : u.login,
                  selected: data.assignees.some((a) => a.login === u.login),
                  node: <Person {...u} />,
                }))}
                // The provider's own list, never a free-text login: assigning someone with no
                // access is refused by every provider, so a box that accepted it would be a box
                // that lies.
                emptyText="Nobody here can be assigned."
                onToggle={(login) =>
                  save({
                    assignees: toggle(
                      data.assignees.map((a) => a.login),
                      login,
                    ),
                  })
                }
                pending={update.isPending}
              />

              <Field
                icon={<Tag aria-hidden className="size-3.5" />}
                label="Labels"
                reason={reasonFor(data, "labels")}
                editable={canWrite(data, "labels")}
                trigger={
                  data.labels.length === 0 ? (
                    <span className="text-2xs text-muted-foreground/60">None</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {data.labels.map((name) => {
                        const known = data.availableLabels.find((l) => l.name === name);
                        return (
                          <Badge
                            key={name}
                            variant="outline"
                            style={
                              known?.color
                                ? { borderColor: `#${known.color}`, color: `#${known.color}` }
                                : undefined
                            }
                          >
                            {name}
                          </Badge>
                        );
                      })}
                    </span>
                  )
                }
                options={data.availableLabels.map((l) => ({
                  key: l.name,
                  label: l.name,
                  selected: data.labels.includes(l.name),
                  node: <span className="truncate text-xs">{l.name}</span>,
                }))}
                emptyText="This repository has no labels."
                onToggle={(name) => save({ labels: toggle(data.labels, name) })}
                pending={update.isPending}
              />

              <Field
                icon={<Plus aria-hidden className="size-3.5" />}
                label="Milestone"
                reason={reasonFor(data, "milestone")}
                editable={canWrite(data, "milestone")}
                trigger={
                  data.milestone ? (
                    <span className="text-xs">{data.milestone.title}</span>
                  ) : (
                    <span className="text-2xs text-muted-foreground/60">None</span>
                  )
                }
                options={[
                  {
                    key: "",
                    label: "No milestone",
                    selected: data.milestone === null,
                    node: <span className="text-muted-foreground text-xs">No milestone</span>,
                  },
                  ...data.availableMilestones.map((m) => ({
                    key: m.externalId,
                    label: m.title,
                    selected: data.milestone?.externalId === m.externalId,
                    node: <span className="truncate text-xs">{m.title}</span>,
                  })),
                ]}
                emptyText="This repository has no milestones."
                // One at a time, unlike labels and assignees — a milestone is single-valued on every
                // provider here, so choosing one replaces rather than toggles.
                onToggle={(id) => save({ milestone: id === "" ? null : id })}
                pending={update.isPending}
              />

              {update.error && (
                // The provider's own refusal, verbatim: "assignee has no access" and "the save is
                // broken" call for different actions, and only one of them is true.
                <p className="text-2xs text-state-failed">{update.error.message}</p>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}

/** A labelled row whose value is either a picker or a sentence saying why it is not. */
function Field({
  icon,
  label,
  reason,
  editable,
  trigger,
  options,
  emptyText,
  onToggle,
  pending,
}: {
  icon: React.ReactNode;
  label: string;
  reason: string | null;
  editable: boolean;
  trigger: React.ReactNode;
  options: Array<{ key: string; label: string; selected: boolean; node: React.ReactNode }>;
  emptyText: string;
  onToggle: (key: string) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1.5">
      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        {icon}
        {label}
      </span>
      {editable ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Edit ${label.toLowerCase()}`}
              disabled={pending}
              className="w-full rounded border border-transparent px-1.5 py-1 text-left hover:border-input hover:bg-accent/40 disabled:opacity-50"
            >
              {trigger}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="start">
            <Command>
              <CommandInput placeholder={`Search ${label.toLowerCase()}…`} className="h-8" />
              <CommandList>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup>
                  {options.map((o) => (
                    <CommandItem
                      key={o.key || "__none"}
                      value={o.label}
                      onSelect={() => {
                        setOpen(false);
                        onToggle(o.key);
                      }}
                    >
                      {o.node}
                      {o.selected && <span className="ml-auto text-2xs">✓</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      ) : (
        <div className="space-y-1 px-1.5 py-1">
          {trigger}
          {reason && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Unavailable reason={reason} />
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{reason}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
