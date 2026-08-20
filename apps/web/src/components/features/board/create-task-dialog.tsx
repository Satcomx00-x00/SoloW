"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
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

/** Conventional create-Task form in a modal dialog (React Hook Form + Zod). */
export function CreateTaskDialog() {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  // The command palette can ask for this dialog from anywhere in the shell.
  useEffect(() => onOpenCreateDialog("task", () => setOpen(true)), []);
  const issues = trpc.issue.list.useQuery({});
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

  const create = trpc.task.create.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
      form.reset();
      setOpen(false);
    },
  });

  const missingConfig =
    (issues.data?.length ?? 0) === 0 ||
    (agents.data?.length ?? 0) === 0 ||
    (executors.data?.length ?? 0) === 0 ||
    (repos.data?.length ?? 0) === 0;

  const selectField = (
    name: "issueId" | "agentProfileId" | "executorProfileId" | "repositoryId",
    label: string,
    placeholder: string,
    options: { id: string; label: string }[],
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select value={field.value} onValueChange={field.onChange}>
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
      <DialogTrigger asChild>
        <Button size="sm" className="h-8">
          <Plus /> New task
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Assign an agent, executor, and repository to run a task.
          </DialogDescription>
        </DialogHeader>
        {missingConfig ? (
          <p className="text-muted-foreground text-sm">
            {(issues.data?.length ?? 0) === 0 ? (
              <>
                Import an Issue from the <span className="font-medium text-foreground">Issues</span>{" "}
                page first — connect GitHub or GitLab in{" "}
                <span className="font-medium text-foreground">Settings → Integrations</span> if you
                haven't yet.
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
              className="space-y-4"
              noValidate
            >
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Investigate servo current-draw limits" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {selectField(
                "issueId",
                "Issue",
                "Select an issue",
                (issues.data ?? []).map((i) => ({ id: i.id, label: i.title })),
              )}
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
              {selectField(
                "repositoryId",
                "Repository",
                "Select a repository",
                (repos.data ?? []).map((r) => ({ id: r.id, label: r.name })),
              )}
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
              {create.error && (
                <p className="text-destructive text-sm" role="alert">
                  {create.error.message}
                </p>
              )}
              <DialogFooter>
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
