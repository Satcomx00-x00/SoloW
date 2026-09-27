"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { TaskDto } from "@solow/contracts";
import { ChevronRight, GitBranchPlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { TaskStateBadge } from "@/components/features/board/task-state-badge";
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
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";

/**
 * A Task's sub-tasks, as the rail lists them (issue #56).
 *
 * In the rail rather than a tab, beside Dependencies, because it is the same kind of fact — how
 * this Task relates to other Tasks — and a reviewer reading the run should see that part of it
 * was split off without leaving the evidence they are reading.
 *
 * The empty state is a sentence, not nothing: the rail is where the Split control lives, so an
 * operator who has never split a Task still has to be able to find out what it would do.
 */
export function SubtaskList({ task }: { task: TaskDto }) {
  const children = trpc.task.list.useQuery({ parentTaskId: task.id, ...WHOLE_PAGE });
  const items = children.data?.items ?? [];

  if (children.isError) {
    return (
      <p className="text-destructive text-xs" role="alert">
        Could not load the sub-tasks: {children.error.message}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        Nothing split off this task. A sub-task keeps this one's setup, is briefed with its
        transcript so far, and works in a worktree of its own.
      </p>
    );
  }
  return (
    <ul className="space-y-0.5" data-subtasks>
      {items.map((child) => (
        <li key={child.id}>
          <Link
            className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent"
            href={`/task/${child.id}`}
          >
            <span className="min-w-0 flex-1 truncate">{child.title}</span>
            <TaskStateBadge size="sm" state={child.state} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

const splitFormSchema = z.object({
  title: z.string().trim().min(1, "Say what the sub-task is for").max(200),
  /** Whether the child is briefed with the parent's transcript, or starts cold. */
  fork: z.boolean(),
});

/**
 * "Split into sub-task": the rail control and the dialog it opens.
 *
 * The dialog asks for a title and whether to carry the parent's transcript, and nothing else.
 * The Issue, Harness Profile, Executor Profile, Repositories and Workflow are the parent's,
 * filled in server-side, and the dialog says so rather than re-asking: a split that reopened the
 * whole create form would ask five questions the parent already answers, and that is how it
 * would go unused. A sub-task that needs a different harness or repository is corrected on the
 * Task page it lands on, where the controls for that already are.
 *
 * `hasTranscript` is whether the parent has run at all. Splitting a Task still in the backlog is
 * legal — it just has nothing to carry — and the checkbox says that instead of promising context
 * that is not there.
 */
export function SplitTaskButton({
  task,
  hasTranscript,
}: {
  task: TaskDto;
  hasTranscript: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        aria-label="Split into sub-task"
        className="text-muted-foreground"
        onClick={() => setOpen(true)}
        size="icon"
        title="Split into sub-task"
        variant="ghost"
      >
        <GitBranchPlus />
      </Button>
      <SplitTaskDialog
        hasTranscript={hasTranscript}
        onOpenChange={setOpen}
        open={open}
        task={task}
      />
    </>
  );
}

function SplitTaskDialog({
  task,
  hasTranscript,
  open,
  onOpenChange,
}: {
  task: TaskDto;
  hasTranscript: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const form = useForm<z.infer<typeof splitFormSchema>>({
    resolver: zodResolver(splitFormSchema),
    defaultValues: { title: "", fork: true },
  });

  const create = trpc.task.createSubtask.useMutation({
    onSuccess: () => {
      void utils.task.list.invalidate();
      onOpenChange(false);
      form.reset({ title: "", fork: true });
    },
  });

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) create.reset();
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Split into a sub-task</DialogTitle>
          <DialogDescription>
            The new task keeps this one's issue, harness, executor, workflow and repositories, and
            gets a worktree and a branch of its own. It is created in the backlog — nothing starts
            until you launch it.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) =>
              create.mutate({
                parentTaskId: task.id,
                title: values.title,
                fork: hasTranscript && values.fork,
              }),
            )}
          >
            <DialogBody className="space-y-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input autoFocus placeholder="What this piece is for" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="fork"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-2.5">
                    <FormControl>
                      <Checkbox
                        checked={hasTranscript && field.value}
                        disabled={!hasTranscript}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                    </FormControl>
                    <div className="space-y-0.5">
                      <FormLabel className="font-normal">
                        Start from this task's transcript
                      </FormLabel>
                      <p className="text-muted-foreground text-xs">
                        {hasTranscript
                          ? "The sub-task is briefed with what this one has done so far instead of starting cold. This task is only read — it carries on untouched."
                          : "This task has not run yet, so there is no transcript to carry. The sub-task starts from its own brief."}
                      </p>
                    </div>
                  </FormItem>
                )}
              />
              {create.error ? (
                <p className="text-destructive text-xs" role="alert">
                  {create.error.message}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
                Cancel
              </Button>
              <Button loading={create.isPending} type="submit">
                Create sub-task
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * How far up the breadcrumb walks before it stops naming Tasks. Each level is a `task.get`, and
 * past a few levels the chain says less than the room it takes from the title beside it.
 */
export const PARENT_CHAIN_DEPTH = 3;

/**
 * The parent chain, in the header before the title (issue #56): `Grandparent › Parent ›` then
 * the title the header already shows.
 *
 * Walked one `task.get` per level, following `parentTaskId` up, rather than carried on the DTO —
 * every board tile would otherwise pay for an ancestor list to render a relationship most Tasks
 * do not have. Each crumb renders nothing until its title arrives: a placeholder would be one
 * more thing moving in a header that already resizes when the state badge changes, and a link is
 * only worth showing once it can say where it goes.
 */
export function ParentChain({ parentTaskId }: { parentTaskId: string }) {
  return (
    <nav aria-label="Split from" className="flex min-w-0 shrink items-center">
      <ParentCrumb depth={1} id={parentTaskId} />
    </nav>
  );
}

function ParentCrumb({ id, depth }: { id: string; depth: number }) {
  const parent = trpc.task.get.useQuery({ id });
  if (!parent.data) return null;
  const grandparent = parent.data.parentTaskId;
  return (
    <>
      {grandparent ? (
        depth < PARENT_CHAIN_DEPTH ? (
          <ParentCrumb depth={depth + 1} id={grandparent} />
        ) : (
          <span className="flex shrink-0 items-center text-muted-foreground text-xs">
            …
            <ChevronRight aria-hidden className="size-3" />
          </span>
        )
      ) : null}
      <span className="flex min-w-0 items-center text-muted-foreground text-xs">
        <Link
          className="min-w-0 max-w-48 truncate hover:text-foreground hover:underline"
          href={`/task/${id}`}
        >
          {parent.data.title}
        </Link>
        <ChevronRight aria-hidden className="size-3 shrink-0" />
      </span>
    </>
  );
}
