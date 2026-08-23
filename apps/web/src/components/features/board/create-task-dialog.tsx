"use client";

import type { IssueDto } from "@gatecontrol/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronRight, ExternalLink, Plus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
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
import { ISSUE_SOURCE_LABELS, ISSUE_STATUS_LABELS, ISSUE_STATUS_STYLE } from "@/lib/issue-status";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { onOpenCreateDialog } from "./create-dialog-bus";

/**
 * The repository the agent is started in stays a single Select, and any others are ticked
 * beside it (issue #7).
 *
 * A flat multi-select would be the obvious shape and the wrong one: the agent process gets
 * exactly one working directory, so one attachment is materially different from the rest, and a
 * form that treated them as interchangeable would hide the one thing the Owner needs to decide.
 */
const taskFormSchema = z.object({
  title: z.string().min(1, "Enter a task title"),
  issueId: z.string().min(1, "Select an issue"),
  agentProfileId: z.string().min(1, "Select an agent profile"),
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
 * was choosing the brief for an agent run from a fragment of it, and had to open the Issue in
 * another tab to read what they had just picked. Everything the Issue actually carries is here
 * instead — the body as written, its labels, its status, and the link back to the provider.
 *
 * Not its comments: GateControl does not have them. The import brings across a title, a body and
 * labels, and there is no `issue_comment` anywhere in the schema to read from — showing an empty
 * "Comments" heading would claim the discussion was empty rather than absent.
 *
 * `whitespace-pre-wrap` rather than rendered markdown, matching the Issue detail page: a body
 * from GitHub is markdown, and the two surfaces disagreeing about how to draw the same string
 * would be worse than both drawing it plainly.
 */
function IssuePreview({ issue }: { issue: IssueDto }) {
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

      {/* Where it really lives (spec F01 FR-4). The copy here is GateControl's; this is the
          original, and it is the only way to reach the discussion the body does not include. */}
      {issue.externalUrl && (
        <a
          href={issue.externalUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
        >
          <span>{ISSUE_SOURCE_LABELS[issue.source]}</span>
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
 * Open state is controlled when the caller passes it — that is how the shell header's Create
 * menu drives this dialog from outside the board — and internal otherwise, so rendering it bare
 * still gives a working "New task" button.
 */
export function CreateTaskDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  /** Omitted when the caller opens the dialog itself; the default button is used otherwise. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const utils = trpc.useUtils();
  // Anything in the shell can ask for this dialog by name — the command palette, and the header's
  // Create menu. Skipped when controlled: the owner is already listening on the bus itself, and
  // both reacting would fight over one piece of state.
  const uncontrolled = controlledOpen === undefined;
  useEffect(() => {
    if (!uncontrolled) return;
    return onOpenCreateDialog("task", () => setInternalOpen(true));
  }, [uncontrolled]);
  // Unfiltered — used only to decide whether the Workspace has *any* Issue at all (the
  // "missingConfig" gate below). The picker itself reads from `issues` (filtered), so a
  // Repository with zero Issues narrows the picker to empty without hiding the whole form.
  const allIssues = trpc.issue.list.useQuery({});
  const agents = trpc.profile.agent.list.useQuery({});
  const executors = trpc.profile.executor.list.useQuery({});
  const repos = trpc.repository.list.useQuery({});

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

  // The Issue picker narrows to the chosen Repository the moment one is picked (user report:
  // "the issue picker in Task creation should auto-populate from the selected Repository") —
  // same `issue.list` query, one more input field, watched reactively off the form.
  const repositoryId = form.watch("repositoryId");
  const issues = trpc.issue.list.useQuery(repositoryId ? { repositoryId } : {});
  // `issue.list` already carries the body, the labels and the status — the same `issueDto` the
  // detail page reads — so showing the whole Issue costs no extra request.
  const issueId = form.watch("issueId");
  const selectedIssue = (issues.data ?? []).find((i) => i.id === issueId) ?? null;

  const create = trpc.task.create.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
      form.reset();
      setOpen(false);
    },
  });

  const missingConfig =
    (allIssues.data?.length ?? 0) === 0 ||
    (agents.data?.length ?? 0) === 0 ||
    (executors.data?.length ?? 0) === 0 ||
    (repos.data?.length ?? 0) === 0;

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
            Assign an agent, executor, and repository to run a task.
          </DialogDescription>
        </DialogHeader>
        {missingConfig ? (
          <p className="text-muted-foreground text-sm">
            {(allIssues.data?.length ?? 0) === 0 ? (
              <>
                Create or import an Issue first — the{" "}
                <span className="font-medium text-foreground">Create</span> menu in the header has
                both. Connect GitHub or GitLab in{" "}
                <span className="font-medium text-foreground">Settings → Integrations</span> to
                import instead of typing one in.
              </>
            ) : (
              <>
                Configure a secret, an agent and executor profile, and a repository in{" "}
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
                    // position 0 is the worktree the agent is started in.
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
                    (repos.data ?? []).map((r) => ({ id: r.id, label: r.name })),
                    // A previously chosen Issue from a different Repository must not silently ride
                    // along once the Repository changes underneath it.
                    () => form.setValue("issueId", ""),
                  )}
                  {selectField(
                    "issueId",
                    "Issue",
                    repositoryId ? "Select an issue" : "Select a repository first",
                    (issues.data ?? []).map((i) => ({ id: i.id, label: i.title })),
                    // The Task is the Issue's work, so it starts out named after it. Typing your
                    // own title stops that — `setValue` here leaves the field pristine, so
                    // `isDirty` means "a person edited this" and nothing else, and a deliberate
                    // title is not silently replaced by picking a different Issue afterwards.
                    (value) => {
                      const picked = (issues.data ?? []).find((i) => i.id === value);
                      if (picked && !form.getFieldState("title").isDirty) {
                        form.setValue("title", picked.title);
                      }
                    },
                  )}
                </div>

                {selectedIssue && <IssuePreview issue={selectedIssue} />}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {selectField(
                    "agentProfileId",
                    "Agent profile",
                    "Select an agent",
                    (agents.data ?? []).map((a) => ({ id: a.id, label: a.name })),
                  )}
                  {selectField(
                    "executorProfileId",
                    "Executor",
                    "Select an executor",
                    (executors.data ?? []).map((x) => ({ id: x.id, label: x.name })),
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
                        const others = (repos.data ?? []).filter(
                          (r) => r.id !== form.watch("repositoryId"),
                        );
                        if (others.length === 0) return <FormItem />;
                        return (
                          <FormItem>
                            <FormLabel>Also works in</FormLabel>
                            <p className="text-muted-foreground text-xs">
                              Each gets its own worktree and its own branch. The agent runs in the
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
