"use client";

import type { IssueDetailDto, IssueField } from "@solow/contracts";
import {
  CalendarDays,
  Check,
  CircleCheck,
  CircleDot,
  ExternalLink,
  EyeOff,
  ListTree,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Tag,
  Timer,
  Trash2,
  Users,
  Weight,
} from "lucide-react";
import { useEffect, useState } from "react";
import { DeleteIssueAction } from "@/components/features/issues/delete-issue-action";
import { AgentMarkdown } from "@/components/features/task/markdown";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { trpc } from "@/trpc/react";
import { groupLabelsByCategory, MarkdownField } from "./issue-authoring";
import { IssueComments } from "./issue-comments";
import { IssueLabel } from "./issue-label";
import { SubIssueProgress } from "./project-progress";
import { useRowRefresh } from "./row-refresh";

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
  const refreshRows = useRowRefresh();
  const detail = trpc.issue.detail.useQuery(
    { issueId: issueId ?? "" },
    { enabled: issueId !== null },
  );
  const update = trpc.issue.updateExternal.useMutation({
    onSuccess: () => {
      // The row on the table behind carries the same title and state.
      refreshRows();
      void utils.issue.list.invalidate();
      void utils.issue.detail.invalidate();
      // And the Issue's own page, which draws the same title and labels from `issue.get`. It is
      // a different query over the same mirror this write just updated, so leaving it out means
      // an edit made here shows on the table and not two clicks away.
      void utils.issue.get.invalidate();
    },
  });

  const data = detail.data;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  /** Reading is the default; the source is one click away. Reset whenever the issue changes. */
  const [editingBody, setEditingBody] = useState(false);
  // Reset from the provider's answer whenever it changes — including after a save, which is how
  // a normalised title makes it onto the screen instead of the one that was typed.
  useEffect(() => {
    setTitle(data?.title ?? "");
    setDescription(data?.description ?? "");
    // Opening a different issue must not land you in its editor because the last one was open.
    setEditingBody(false);
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
        <SheetContent /*
            Half the viewport (§11's side panel), not a fixed breakpoint width.

            An issue body is prose and a `max-w-2xl` panel wrapped it into a column narrow enough
            that a table in the description became unreadable. `50vw` with a floor keeps it usable
            on a laptop and generous on a wide screen, which is what the reference does.
          */
          className="flex w-full flex-col gap-0 p-0 sm:!w-[50vw] sm:!max-w-none sm:min-w-[720px]"
        >
          {/*
            The header names the *issue*, not the panel.

            It used to read "#112" over a sentence explaining how editing works — the number is
            the least identifying thing about a row, and the explanation is a rule that does not
            change and does not need saying every time. The title is the heading now; the state,
            the number and the repository sit under it, which is the reference's own arrangement
            (§11) and the one that tells you at a glance what you opened.
          */}
          <SheetHeader className="gap-2 border-b px-5 py-4">
            <SheetTitle className="flex min-w-0 items-start gap-2.5 text-left">
              {data && (
                <span className="mt-0.5 shrink-0">
                  {data.state === "closed" ? (
                    <CircleCheck aria-hidden className="size-[18px] text-scm-closed" />
                  ) : (
                    <CircleDot aria-hidden className="size-[18px] text-scm-open" />
                  )}
                </span>
              )}
              <span className="min-w-0 flex-1 font-semibold text-[15px] leading-snug">
                {data?.title ?? "Issue"}
              </span>
              {update.isPending && (
                <Loader2 aria-hidden className="mt-1 size-3.5 shrink-0 animate-spin" />
              )}
            </SheetTitle>
            <SheetDescription asChild>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-7 text-2xs">
                {data && (
                  <>
                    <span className="font-mono">#{data.externalNumber}</span>
                    <span aria-hidden>·</span>
                    <span className="capitalize">{data.state}</span>
                    {/* The four GitLab-only fields (user request 2026-08-30). Each renders exactly when
                    the provider's manifest says it can be written, and otherwise shows the
                    provider's own sentence — the same `writes`/`cannot` rule every field above
                    follows, so GitHub's drawer states "GitHub issues have no weight" rather than
                    quietly showing one fewer control. */}
                    <ScalarField
                      icon={<CalendarDays aria-hidden className="size-3.5" />}
                      label="Due date"
                      type="date"
                      value={data.dueDate}
                      display={data.dueDate ?? null}
                      reason={reasonFor(data, "dueDate")}
                      editable={canWrite(data, "dueDate")}
                      pending={update.isPending}
                      onCommit={(next) => save({ dueDate: next })}
                    />
                    <ScalarField
                      icon={<Timer aria-hidden className="size-3.5" />}
                      label="Estimate"
                      value={data.timeEstimate}
                      display={data.timeEstimate ?? null}
                      placeholder="e.g. 2h, 3d"
                      reason={reasonFor(data, "timeEstimate")}
                      editable={canWrite(data, "timeEstimate")}
                      pending={update.isPending}
                      onCommit={(next) => save({ timeEstimate: next })}
                    />
                    <ScalarField
                      icon={<Weight aria-hidden className="size-3.5" />}
                      label="Weight"
                      type="number"
                      value={data.weight === null ? "" : String(data.weight)}
                      display={data.weight === null ? null : String(data.weight)}
                      reason={reasonFor(data, "weight")}
                      editable={canWrite(data, "weight")}
                      pending={update.isPending}
                      // An emptied box clears the weight; anything else is a number the schema bounds.
                      onCommit={(next) => save({ weight: next === null ? null : Number(next) })}
                    />
                    {canWrite(data, "confidential") ? (
                      <label
                        htmlFor="issue-confidential"
                        className="flex items-center gap-2 px-1.5 text-xs"
                      >
                        <Checkbox
                          id="issue-confidential"
                          checked={data.confidential}
                          disabled={update.isPending}
                          onCheckedChange={(next) => save({ confidential: next === true })}
                        />
                        <EyeOff aria-hidden className="size-3.5 text-muted-foreground" />
                        Confidential
                      </label>
                    ) : (
                      reasonFor(data, "confidential") && (
                        <div className="space-y-1">
                          <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                            <EyeOff aria-hidden className="size-3.5" />
                            Confidential
                          </span>
                          <div className="px-1.5">
                            <Unavailable reason={reasonFor(data, "confidential") as string} />
                          </div>
                        </div>
                      )
                    )}

                    {data.subIssues.length > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <SubIssueProgress
                          done={data.subIssues.filter((child) => child.closed).length}
                          total={data.subIssues.length}
                        />
                      </>
                    )}
                  </>
                )}
              </span>
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
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[1fr_300px]">
              {/* The issue on the left, its parameters on the right — GitHub's own arrangement.
                  The body is the thing being read; the fields are what you reach for while
                  reading it, and stacking them above pushed the prose off the first screen. */}
              <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
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
                      {reasonFor(data, "title") && (
                        <Unavailable reason={reasonFor(data, "title")!} />
                      )}
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

                {/*
                Rendered, not raw — with an explicit way in to the source.

                The body is Markdown: tables, checklists, code fences, links. A textarea showing
                `## Context` and `| a | b |` is the *source* of an issue, which is what you need
                for ten seconds while editing and never while reading. So reading is the default
                and editing is a button, the way GitHub does it.
              */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="issue-body" className="text-2xs text-muted-foreground">
                      Description
                    </Label>
                    {canWrite(data, "description") && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          // Leaving the editor saves what changed, so the button is both "edit" and
                          // "done" — one control for one piece of state, rather than a Save that can
                          // disagree with a Cancel.
                          if (editingBody && description !== (data.description ?? "")) {
                            save({ description });
                          }
                          setEditingBody(!editingBody);
                        }}
                      >
                        {editingBody ? (
                          <>
                            <Check aria-hidden /> Done
                          </>
                        ) : (
                          <>
                            <Pencil aria-hidden /> Edit
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                  {editingBody && canWrite(data, "description") ? (
                    // The same editor the create dialog uses — a formatting toolbar and a Preview
                    // tab rendered by the very renderer the read view below uses, so what is
                    // previewed while editing is what appears on saving.
                    <MarkdownField
                      value={description}
                      onChange={setDescription}
                      label="Description"
                      disabled={update.isPending}
                    />
                  ) : data.description ? (
                    <div className="rounded-lg border bg-card/40 px-4 py-3">
                      <AgentMarkdown text={data.description} />
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-xs italic">No description.</p>
                  )}
                </div>
                <Separator />

                {/* The discussion, at the foot of the body it is about — read live, never
                    mirrored. See `IssueComments`. */}
                <IssueComments issueId={data.issueId} />
              </div>

              {/*
                The parameters column.

                Everything the provider owns about this issue, in one place you reach for while
                reading rather than one you scroll past to reach the reading. Scrolls on its own,
                so a long body and a long field list do not fight over one scrollbar.
              */}
              <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-t px-5 py-4 lg:border-t-0 lg:border-l">
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
                        {/* The shared component, so a label is the same colour here as in the
                            table the drawer opened from. */}
                        {data.labels.map((name) => (
                          <IssueLabel
                            key={name}
                            name={name}
                            color={data.availableLabels.find((l) => l.name === name)?.color}
                          />
                        ))}
                      </span>
                    )
                  }
                  options={data.availableLabels.map((l) => ({
                    key: l.name,
                    label: l.name,
                    selected: data.labels.includes(l.name),
                    node: <IssueLabel name={l.name} color={l.color} />,
                  }))}
                  // Split into Area/Priority/Status/... groups when the repository actually uses
                  // scoped labels, and left as one flat list when it does not — the same rule, and
                  // the same function, the create dialog's picker follows.
                  groupBy={(options) =>
                    groupLabelsByCategory(
                      options.map((o) => ({ name: o.key, color: null, description: null })),
                    ).map((g) => ({
                      key: g.key,
                      heading: g.heading,
                      items: g.items
                        .map((i) => options.find((o) => o.key === i.name))
                        .filter((o) => o !== undefined),
                    }))
                  }
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

                {data.subIssues.length > 0 && (
                  <>
                    <Separator />
                    <section className="space-y-2">
                      <h3 className="flex items-center gap-2 font-medium text-2xs text-muted-foreground">
                        <ListTree aria-hidden className="size-3.5" />
                        Sub-issues
                        <span className="ml-auto font-normal">
                          {data.subIssues.filter((child) => child.closed).length} of{" "}
                          {data.subIssues.length} closed
                        </span>
                      </h3>
                      {/* The children an epic tracks (§11). Read from the same `external_parent_id`
                      the table nests by, so the panel and the grid cannot disagree about what
                      belongs to this epic. */}
                      <ul className="divide-y rounded-lg border">
                        {data.subIssues.map((child) => (
                          <li key={child.issueId} className="flex items-center gap-2.5 px-3 py-2">
                            {child.closed ? (
                              <CircleCheck
                                aria-hidden
                                className="size-4 shrink-0 text-scm-closed"
                              />
                            ) : (
                              <CircleDot aria-hidden className="size-4 shrink-0 text-scm-open" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-xs" title={child.title}>
                              {child.title}
                            </span>
                            {child.number !== null &&
                              (child.url ? (
                                <a
                                  href={child.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="shrink-0 font-mono text-2xs text-muted-foreground hover:text-foreground hover:underline"
                                >
                                  #{child.number}
                                </a>
                              ) : (
                                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                                  #{child.number}
                                </span>
                              ))}
                          </li>
                        ))}
                      </ul>
                    </section>
                  </>
                )}

                {update.error && (
                  // The provider's own refusal, verbatim: "assignee has no access" and "the save is
                  // broken" call for different actions, and only one of them is true.
                  <p className="text-2xs text-state-failed">{update.error.message}</p>
                )}

                {/*
                  Deleting, last and set apart.

                  It removes SoloW's *record* — the Issue row and the Tasks under it — and
                  never the issue on the provider, which is why it sits below a separator rather
                  than beside "Close issue": those two would otherwise read as two strengths of
                  one action. The confirmation states what goes with it.
                */}
                <Separator className="mt-auto" />
                <DeleteIssueAction
                  issueId={data.issueId}
                  issueTitle={data.title}
                  onSuccess={() => onOpenChange(false)}
                  trigger={
                    <Button
                      size="xs"
                      variant="ghost"
                      className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 aria-hidden /> Delete from SoloW
                    </Button>
                  }
                />
              </aside>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}

/** A labelled row whose value is either a picker or a sentence saying why it is not. */
/**
 * A single typed value the provider owns — a date, a number, a duration (user request
 * 2026-08-30).
 *
 * Not a `Field`: that one is a *pick* from the provider's own vocabulary, and these four have no
 * vocabulary to pick from. What they share with it is the rule that matters — a field the provider
 * cannot hold is the provider's sentence, never a disabled box (F23 FR-5).
 *
 * Commits on blur and on Enter, and only when the value actually changed, so opening the drawer
 * and clicking through it writes nothing. An emptied box commits `null`, which is how every one of
 * these is cleared; `Escape` puts the provider's value back and gives up the edit.
 */
function ScalarField({
  icon,
  label,
  type = "text",
  value,
  display,
  placeholder,
  reason,
  editable,
  pending,
  onCommit,
}: {
  icon: React.ReactNode;
  label: string;
  type?: "text" | "date" | "number";
  /** The provider's current value, as the input should show it. */
  value: string | null;
  /** The same value as the read-only view renders it, or null for "unset". */
  display: string | null;
  placeholder?: string;
  reason: string | null;
  editable: boolean;
  pending: boolean;
  onCommit: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  // Re-seed when the provider's answer changes — a save re-reads the issue, and the box must show
  // what came back rather than what was typed (F23 NFR-7).
  useEffect(() => setDraft(value ?? ""), [value]);

  const commit = () => {
    const next = draft.trim() === "" ? null : draft.trim();
    if (next === (value ?? null)) return;
    onCommit(next);
  };

  return (
    <div className="space-y-1.5">
      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        {icon}
        {label}
      </span>
      {editable ? (
        <Input
          type={type}
          aria-label={label}
          value={draft}
          disabled={pending}
          placeholder={placeholder ?? "—"}
          className="h-7 text-xs"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraft(value ?? "");
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <div className="space-y-1 px-1.5 py-1">
          {display ? (
            <span className="text-xs">{display}</span>
          ) : (
            <span className="text-2xs text-muted-foreground/60">Unset</span>
          )}
          {reason && <Unavailable reason={reason} />}
        </div>
      )}
    </div>
  );
}

function Field({
  icon,
  label,
  reason,
  editable,
  trigger,
  options,
  groupBy,
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
  /**
   * How to split `options` into headed groups. When absent — or when it yields nothing — the whole
   * list renders as one unheaded group, exactly as it always did. Only Labels passes it (user
   * request 2026-08-30: split by category *when there are categories*, one list otherwise).
   */
  groupBy?: (
    options: Array<{ key: string; label: string; selected: boolean; node: React.ReactNode }>,
  ) => Array<{
    key: string;
    heading: string | null;
    items: Array<{ key: string; label: string; selected: boolean; node: React.ReactNode }>;
  }>;
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
                {(groupBy?.(options) ?? [{ key: "__all", heading: null, items: options }]).map(
                  (group) => (
                    <CommandGroup key={group.key} heading={group.heading ?? undefined}>
                      {group.items.map((o) => (
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
                  ),
                )}
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
