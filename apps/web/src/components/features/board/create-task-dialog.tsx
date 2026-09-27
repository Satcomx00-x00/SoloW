"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { IssueDto } from "@solow/contracts";
import { ChevronRight, ExternalLink, Plus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { z } from "zod";
import { useProviderNames } from "@/components/hooks/use-provider-names";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ISSUE_STATUS_LABELS, ISSUE_STATUS_STYLE, issueSourceLabel } from "@/lib/issue-status";
import { WHOLE_PAGE } from "@/lib/paged";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * What the caller opening this dialog already knows, so the form does not ask for it again.
 *
 * It used to be the vocabulary of a document-level event bus shared by four dialogs; with that
 * bus gone and this the only dialog still taking a preset, the type belongs to the component that
 * reads it. Optional throughout, and a *starting point* rather than a lock — every field it fills
 * stays editable, because a right-click is a shortcut and not a decision.
 */
export interface TaskPreset {
  issueId?: string;
  /**
   * The Repository the Issue belongs to.
   *
   * Needed alongside `issueId`, not instead of it: the Issue picker below is narrowed by the
   * chosen Repository and stays disabled ("Select a repository first") until one is picked.
   * Presetting the issue alone therefore looked like it did nothing — the value was in the form
   * and the control that would have shown it was still locked.
   */
  repositoryId?: string;
}

/**
 * The repository the harness is started in stays a single Select, and any others are ticked
 * beside it (issue #7).
 *
 * A flat multi-select would be the obvious shape and the wrong one: the harness process gets
 * exactly one working directory, so one attachment is materially different from the rest, and a
 * form that treated them as interchangeable would hide the one thing the Owner needs to decide.
 */
const taskFormSchema = z.object({
  title: z.string().min(1, "Enter a task title"),
  issueId: z.string().min(1, "Select an issue"),
  agentProfileId: z.string().min(1, "Select a harness profile"),
  executorProfileId: z.string().min(1, "Select an executor"),
  repositoryId: z.string().min(1, "Select a repository"),
  baseRef: z.string(),
  /** Repositories the Task also works in; each gets its own worktree and its own branch. */
  additionalRepositoryIds: z.array(z.string()),
});
type TaskFormValues = z.infer<typeof taskFormSchema>;

/**
 * The Issue the Task is being opened against, shown in full.
 *
 * The picker above is a Select, and a Select shows one line: the title, truncated. So the Owner
 * was choosing the brief for a harness run from a fragment of it, and had to open the Issue in
 * another tab to read what they had just picked. Everything the Issue actually carries is here
 * instead — the body as written, its labels, its status, and the link back to the provider.
 *
 * Not its comments: SoloW does not have them. The import brings across a title, a body and
 * labels, and there is no `issue_comment` anywhere in the schema to read from — showing an empty
 * "Comments" heading would claim the discussion was empty rather than absent.
 *
 * `whitespace-pre-wrap` rather than rendered markdown, matching the Issue detail page: a body
 * from GitHub is markdown, and the two surfaces disagreeing about how to draw the same string
 * would be worse than both drawing it plainly.
 */
function IssuePreview({ issue }: { issue: IssueDto }) {
  const providerName = useProviderNames();
  const status = ISSUE_STATUS_STYLE[issue.status];
  return (
    <section
      aria-label="Selected issue"
      className="space-y-3 rounded-lg border bg-card/40 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
        <h3 className="min-w-0 flex-1 font-medium text-sm leading-snug">{issue.title}</h3>
        <Badge variant="outline" className={cn("shrink-0 gap-1", status.badge)}>
          <status.icon aria-hidden className="size-3" />
          {ISSUE_STATUS_LABELS[issue.status]}
        </Badge>
      </div>

      {/* Where it really lives (spec F01 FR-4). The copy here is SoloW's; this is the
          original, and it is the only way to reach the discussion the body does not include. */}
      {issue.externalUrl && (
        <a
          href={issue.externalUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
        >
          <span>{issueSourceLabel(issue.source, providerName(issue.source))}</span>
          {issue.externalNumber !== null && (
            <span className="font-mono">#{issue.externalNumber}</span>
          )}
          <ExternalLink aria-hidden className="size-3" />
        </a>
      )}

      {issue.description ? (
        /* Capped and scrollable: an imported Issue can carry a thousand lines of stack trace, and
           a dialog that grew to hold it would push its own Create button off the screen. */
        <div className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground text-xs leading-relaxed">
          {issue.description}
        </div>
      ) : (
        <p className="text-muted-foreground/60 text-xs italic">This issue has no description.</p>
      )}

      {issue.labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {issue.labels.map((label) => (
            <Badge key={label} variant="secondary">
              {label}
            </Badge>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Conventional create-Task form in a modal dialog (React Hook Form + Zod).
 *
 * Open state is controlled when the caller passes it — that is how the Issue detail page and the
 * project table's right-click drive this dialog from outside the board — and internal otherwise,
 * so rendering it bare still gives a working "New task" button.
 */
/**
 * Write a caller's starting point into the form.
 *
 * **Repository first.** The Issue picker is narrowed by the chosen Repository and stays disabled
 * ("Select a repository first") until one is set, so writing the issue alone leaves a value that
 * nothing on screen can show — a preset that looks like it did nothing.
 *
 * `shouldDirty` on purpose: these are values the operator chose by right-clicking a row, so Reset
 * returns to an empty form rather than to their click.
 *
 * The *title* is deliberately not written here. A preset names an Issue by id, and the Issue's
 * title is not in hand until `issue.list` has answered — so naming the Task after it belongs
 * with the other asynchronous defaults, below.
 */
function applyPreset(form: UseFormReturn<TaskFormValues>, preset: TaskPreset | undefined): void {
  if (!preset) return;
  if (preset.repositoryId) {
    form.setValue("repositoryId", preset.repositoryId, { shouldDirty: true });
  }
  if (preset.issueId) form.setValue("issueId", preset.issueId, { shouldDirty: true });
}

export function CreateTaskDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
  preset,
}: {
  /** Omitted when the caller opens the dialog itself; the default button is used otherwise. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * A starting point supplied by whoever asked for this dialog — a right-click on a project row,
   * or `New task` on an Issue's own page, both of which already know the Issue and its
   * Repository. Absent when the dialog opens from its own trigger, which knows nothing.
   */
  preset?: TaskPreset | undefined;
} = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const utils = trpc.useUtils();
  // Unfiltered — used only to decide whether the Workspace has *any* Issue at all (the
  // "missingConfig" gate below). The picker itself reads from `issues` (filtered), so a
  // Repository with zero Issues narrows the picker to empty without hiding the whole form.
  const allIssues = trpc.issue.list.useQuery({ ...WHOLE_PAGE });
  const harnesses = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE });
  const executors = trpc.profile.executor.list.useQuery({ ...WHOLE_PAGE });
  const repos = trpc.repository.list.useQuery({ ...WHOLE_PAGE });
  /*
   * The Harness Profile and Executor a new Task starts with (spec F16). `retry: false` because
   * this is a convenience behind its own feature flag: a Workspace that has not turned it on
   * must get a form that opens empty, not one that retries a forbidden read before giving up.
   */
  const taskDefaults = trpc.preference.getTaskDefaults.useQuery({}, { retry: false });

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: {
      title: "",
      issueId: "",
      agentProfileId: "",
      executorProfileId: "",
      repositoryId: "",
      baseRef: "",
      additionalRepositoryIds: [],
    },
  });

  /*
   * The only way a preset reaches the form. There used to be a second one — a subscription to a
   * document-level bus that the shell header's Create menu dispatched on — and it went with that
   * menu; the two callers left both render this dialog themselves, on the same page as the button
   * that asked for it, so passing the value down is the whole of the hand-off.
   *
   * Keyed on `preset` by identity, so a *new* request re-applies even while the dialog is already
   * open. That is precisely why both callers hold the preset in state rather than building the
   * object inline in their JSX: a fresh object every render would stamp the preset back over a
   * Repository or Issue the operator had since changed.
   *
   * Declared after the form because the preset is written into it.
   */
  useEffect(() => {
    if (open && preset) applyPreset(form, preset);
  }, [open, preset, form]);

  // The Issue picker narrows to the chosen Repository the moment one is picked (user report:
  // "the issue picker in Task creation should auto-populate from the selected Repository") —
  // same `issue.list` query, one more input field, watched reactively off the form.
  const repositoryId = form.watch("repositoryId");
  const issues = trpc.issue.list.useQuery(
    repositoryId ? { ...WHOLE_PAGE, repositoryId } : WHOLE_PAGE,
  );
  // `issue.list` already carries the body, the labels and the status — the same `issueDto` the
  // detail page reads — so showing the whole Issue costs no extra request.
  const issueId = form.watch("issueId");
  const selectedIssue = (issues.data?.items ?? []).find((i) => i.id === issueId) ?? null;

  const create = trpc.task.create.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
      form.reset();
      setOpen(false);
    },
  });

  const missingConfig =
    (allIssues.data?.items.length ?? 0) === 0 ||
    (harnesses.data?.items.length ?? 0) === 0 ||
    (executors.data?.items.length ?? 0) === 0 ||
    (repos.data?.items.length ?? 0) === 0;

  /**
   * What the form starts as, once the server has said: the Task named after its Issue, and the
   * two profile pickers on the Owner's stored defaults (spec F16).
   *
   * Naming the Task after its Issue used to hang off the Issue picker's `onChange`, which fired
   * for an Issue chosen by hand and never for one arriving in a `preset` — so every Task cut
   * from an Issue's own page, the common path, opened with an empty Title while the picker path
   * filled it in. Keyed on the *resolved Issue* instead, both paths are one path.
   *
   * **The three values are watched, and the effect is deliberately un-keyed.** Both are load
   * bearing, and together they are the whole reason this works. `useController` subscribes each
   * *field* to the form, so writing a value re-renders that field and nothing else: without a
   * watch this component would not re-render, and an un-keyed effect would still only run once.
   * That matters because the dialog's content is portalled — its pickers register with React
   * Hook Form some time after the effect that seeds them, and a value written before a field
   * exists is discarded when that field registers with its own default. Watching makes this
   * component a subscriber, so when a picker finally registers the effect runs again and
   * re-asserts; the un-keyed effect is what gives it that second chance. With a one-shot write
   * the seed silently loses that race — which is exactly how the two pickers came to be sent
   * empty while visibly showing a profile.
   *
   * Two guards make this a *default* rather than a lock, and they are the feature: a field the
   * operator has touched is never written, and neither is one that already holds a value. So
   * picking a different Issue after typing your own title leaves your words alone. `setValue`
   * without `shouldDirty` keeps the field pristine, so `isDirty` goes on meaning "a person
   * edited this" and nothing else.
   *
   * A stored Profile is only offered if it is in the list on screen. `getTaskDefaults` already
   * drops an id whose Profile has been deleted; this is the belt to those braces, because a
   * picker holding a value it has no option to draw is what a form ignoring you looks like.
   */
  const issueForTitle =
    selectedIssue ?? (allIssues.data?.items ?? []).find((i) => i.id === issueId) ?? null;
  const storedDefaults = taskDefaults.data?.defaults;
  const currentTitle = form.watch("title");
  const currentHarness = form.watch("agentProfileId");
  const currentExecutor = form.watch("executorProfileId");
  useEffect(() => {
    if (!open || missingConfig) return;
    const seed = (name: keyof TaskFormValues, current: string, value: string | undefined) => {
      if (!value || current) return;
      if (form.getFieldState(name).isDirty) return;
      form.setValue(name, value);
    };
    const inList = (id: string | null | undefined, options: readonly { id: string }[]) =>
      id && options.some((option) => option.id === id) ? id : undefined;

    seed("title", currentTitle, issueForTitle?.title);
    seed(
      "agentProfileId",
      currentHarness,
      inList(storedDefaults?.harnessProfileId, harnesses.data?.items ?? []),
    );
    seed(
      "executorProfileId",
      currentExecutor,
      inList(storedDefaults?.executorProfileId, executors.data?.items ?? []),
    );
  });

  const selectField = (
    name: "issueId" | "agentProfileId" | "executorProfileId" | "repositoryId",
    label: string,
    placeholder: string,
    options: { id: string; label: string }[],
    /** Extra side effect on selection, beyond updating this field's own value. */
    onChange?: (value: string) => void,
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select
            value={field.value}
            onValueChange={(value) => {
              field.onChange(value);
              onChange?.(value);
            }}
          >
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger === undefined ? (
        <DialogTrigger asChild>
          <Button size="sm" className="h-8">
            <Plus /> New task
          </Button>
        </DialogTrigger>
      ) : trigger === null ? null : (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      )}
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Assign a harness, executor, and repository to run a task.
          </DialogDescription>
        </DialogHeader>
        {missingConfig ? (
          <p className="text-muted-foreground text-sm">
            {(allIssues.data?.items.length ?? 0) === 0 ? (
              /* This used to send people to the header's Create menu, which had both "New issue"
                 and "Import issues" on it. That menu is gone, so the copy names the surface that
                 exists — and deliberately does not promise an import, which currently has no
                 entry point of its own. Sending an operator to a button that is not there is the
                 failure this whole paragraph exists to prevent. */
              <>
                Create an Issue first — a Project&apos;s{" "}
                <span className="font-medium text-foreground">New</span> menu creates one on the
                provider that owns it. Connect GitHub or GitLab in{" "}
                <span className="font-medium text-foreground">Settings → Integrations</span> if this
                Workspace has no provider behind it yet.
              </>
            ) : (
              <>
                Configure a secret, a harness and executor profile, and a repository in{" "}
                <span className="font-medium text-foreground">Settings</span> first.
              </>
            )}
          </p>
        ) : (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(
                ({ repositoryId, baseRef, additionalRepositoryIds, ...values }) =>
                  create.mutate({
                    ...values,
                    // The chosen repository first: array order is what becomes `position`, and
                    // position 0 is the worktree the harness is started in.
                    repositories: [
                      { repositoryId, ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}) },
                      ...additionalRepositoryIds
                        .filter((id) => id !== repositoryId)
                        .map((id) => ({ repositoryId: id })),
                    ],
                  }),
              )}
              className="flex min-h-0 flex-1 flex-col gap-4"
              noValidate
            >
              <DialogBody className="space-y-4">
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g. Investigate servo current-draw limits"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {/* Paired across two columns now the dialog is wide enough for it: each of these
                  four is a one-line Select, and stacking them made a short form scroll for no
                  reason. Repository still precedes Issue in source order — the Issue picker's
                  list depends on which Repository is chosen, so the field that decides comes
                  first for both reading order and keyboard tab order. */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {selectField(
                    "repositoryId",
                    "Repository",
                    "Select a repository",
                    (repos.data?.items ?? []).map((r) => ({ id: r.id, label: r.name })),
                    // A previously chosen Issue from a different Repository must not silently ride
                    // along once the Repository changes underneath it.
                    () => form.setValue("issueId", ""),
                  )}
                  {selectField(
                    "issueId",
                    "Issue",
                    repositoryId ? "Select an issue" : "Select a repository first",
                    (issues.data?.items ?? []).map((i) => ({ id: i.id, label: i.title })),
                    // No title side-effect here any more: the Task is named after its Issue by
                    // the seeding effect above, which sees a preset Issue as well as a picked
                    // one. The Task is the Issue's work, so it starts out named after it, and a
                    // title the operator typed is never replaced.
                  )}
                </div>

                {selectedIssue && <IssuePreview issue={selectedIssue} />}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {selectField(
                    "agentProfileId",
                    "Harness profile",
                    "Select a harness",
                    (harnesses.data?.items ?? []).map((a) => ({ id: a.id, label: a.name })),
                  )}
                  {selectField(
                    "executorProfileId",
                    "Executor",
                    "Select an executor",
                    (executors.data?.items ?? []).map((x) => ({ id: x.id, label: x.name })),
                  )}
                </div>
                {/*
                  The two escape hatches, folded away.
                  
                  Both were asked to go: they sat between the Owner and the Create button on
                  every Task, and neither is answered on more than a handful. Base ref defaults
                  to HEAD, which is what almost every run wants; a second repository is the
                  exception issue #7 exists for, not the norm. Closed by default rather than
                  deleted, because deleting the checkbox list would leave multi-repository Tasks
                  reachable only through the API — and Principle II's isolation guarantee is
                  covered by an e2e test that creates one through this form.

                  A native `details`, as the transcript's tool calls already use: it is a
                  disclosure, the browser owns the open state, and it needs no JavaScript.
                */}
                <details className="group rounded-lg border bg-card/30 px-3.5 py-2.5">
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-muted-foreground text-xs transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                      aria-hidden
                      className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
                    />
                    Advanced
                  </summary>
                  <div className="mt-3 space-y-4">
                    <FormField
                      control={form.control}
                      name="baseRef"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Base ref</FormLabel>
                          <FormControl>
                            <Input placeholder="Defaults to HEAD" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="additionalRepositoryIds"
                      render={({ field }) => {
                        const others = (repos.data?.items ?? []).filter(
                          (r) => r.id !== form.watch("repositoryId"),
                        );
                        if (others.length === 0) return <FormItem />;
                        return (
                          <FormItem>
                            <FormLabel>Also works in</FormLabel>
                            <p className="text-muted-foreground text-xs">
                              Each gets its own worktree and its own branch. The harness runs in the
                              repository above and is told where the others are.
                            </p>
                            <div className="space-y-1.5">
                              {others.map((r) => (
                                <label
                                  key={r.id}
                                  className="flex items-center gap-2 text-sm"
                                  htmlFor={`additional-repo-${r.id}`}
                                >
                                  <Checkbox
                                    id={`additional-repo-${r.id}`}
                                    checked={field.value.includes(r.id)}
                                    onCheckedChange={(checked) =>
                                      field.onChange(
                                        checked === true
                                          ? [...field.value, r.id]
                                          : field.value.filter((id: string) => id !== r.id),
                                      )
                                    }
                                  />
                                  {r.name}
                                </label>
                              ))}
                            </div>
                            <FormMessage />
                          </FormItem>
                        );
                      }}
                    />
                  </div>
                </details>

                {create.error && (
                  <p className="text-destructive text-sm" role="alert">
                    {create.error.message}
                  </p>
                )}
              </DialogBody>
              <DialogFooter className="border-t pt-4">
                <Button type="submit" loading={create.isPending}>
                  Create task
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
