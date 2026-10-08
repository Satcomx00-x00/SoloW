"use client";

import { quickTaskProfiles } from "@solow/contracts";
import Link from "next/link";
import { useState } from "react";
import { HostRunWarning } from "@/components/features/host-run-warning";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { WHOLE_PAGE } from "@/lib/paged";
import { taskActionMessage } from "@/lib/task-errors";
import { taskHref } from "@/lib/task-href";
import { trpc } from "@/trpc/react";

/**
 * Quick task (roadmap E2): one sentence in, a running agent out.
 *
 * It calls `task.quickStart`, which makes the Issue and the Task and starts the run in one
 * request, so the Owner is never asked for an Issue, a Harness Profile or an Executor Profile
 * before seeing any work happen. The full form stays one click away for the cases that need those
 * choices; it is a link in the footer rather than a second button because it is the exception.
 *
 * The Repository is asked for only when there is more than one, and then nothing is preselected:
 * which codebase an agent edits is not a choice to make for the Owner by list order. With a single
 * Repository the question has one answer, and the server resolves it the same way.
 *
 * The profiles are never asked for, but the host-run warning still applies to them: the dialog
 * works out the pair the server will use, by the same `quickTaskProfiles` rule, and warns when
 * that pair is a never-ask harness on the host.
 */
export function QuickTaskDialog({
  open,
  onOpenChange,
  onFullForm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hand over to the full create form. Omitted where there is no such form to offer. */
  onFullForm?: (() => void) | undefined;
}) {
  const utils = trpc.useUtils();
  const repos = trpc.repository.list.useQuery({ ...WHOLE_PAGE }, { enabled: open });
  const harnesses = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE }, { enabled: open });
  const executors = trpc.profile.executor.list.useQuery({ ...WHOLE_PAGE }, { enabled: open });
  const taskDefaults = trpc.preference.getTaskDefaults.useQuery(
    {},
    { enabled: open, retry: false },
  );
  const [prompt, setPrompt] = useState("");
  const [chosenRepositoryId, setChosenRepositoryId] = useState("");
  /**
   * A Task this dialog created whose run was refused. Kept on screen with a way to it, and the
   * sentence cleared, so the same click cannot make a second Issue and Task for the same work.
   */
  const [notStarted, setNotStarted] = useState<{
    task: { id: string; state: string };
    reason: string | null;
  } | null>(null);

  const repositories = repos.data?.items ?? [];
  const askRepository = repositories.length > 1;
  const repositoryId = askRepository ? chosenRepositoryId : (repositories[0]?.id ?? "");
  const picked = quickTaskProfiles({
    stored: taskDefaults.data?.defaults ?? null,
    harnesses: harnesses.data?.items ?? [],
    executors: executors.data?.items ?? [],
  });

  const start = trpc.task.quickStart.useMutation({
    onSuccess: (out) => {
      // Written either way, so every list that shows Issues or Tasks is stale either way.
      utils.task.list.invalidate();
      utils.issue.list.invalidate();
      utils.project.allItems.invalidate();
      setPrompt("");
      if (!out.started) {
        setNotStarted({ task: out.task, reason: out.reason });
        return;
      }
      onOpenChange(false);
    },
  });

  const canSubmit = prompt.trim().length > 0 && (!askRepository || repositoryId.length > 0);
  const submit = () => {
    if (!canSubmit || start.isPending) return;
    start.mutate({
      prompt: prompt.trim(),
      ...(askRepository ? { repositoryId } : {}),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          start.reset();
          setNotStarted(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Describe the work. SoloW creates the issue, the task and its worktree, and starts the
            agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="quick-task-prompt">What should the agent do?</Label>
            <Textarea
              id="quick-task-prompt"
              autoFocus
              rows={5}
              maxLength={5000}
              value={prompt}
              placeholder="Add a /health endpoint that returns the build version"
              onChange={(event) => {
                setPrompt(event.target.value);
                setNotStarted(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
              }}
            />
          </div>

          {askRepository ? (
            <div className="space-y-1.5">
              <Label htmlFor="quick-task-repository">Repository</Label>
              <Select value={repositoryId} onValueChange={setChosenRepositoryId}>
                <SelectTrigger id="quick-task-repository">
                  <SelectValue placeholder="Choose a repository" />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((repo) => (
                    <SelectItem key={repo.id} value={repo.id}>
                      {repo.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <HostRunWarning
            executorKind={
              executors.data?.items.find((x) => x.id === picked.executorProfileId)?.kind
            }
            permissionMode={
              harnesses.data?.items.find((h) => h.id === picked.agentProfileId)?.permissionMode
            }
          />

          {notStarted ? (
            <p role="alert" className="text-sm">
              <span className="text-feedback-error">
                Task created but not started: {taskActionMessage(notStarted.reason)}
              </span>{" "}
              <Link
                href={taskHref(notStarted.task)}
                className="underline underline-offset-2 hover:text-primary"
                onClick={() => onOpenChange(false)}
              >
                Open the task
              </Link>
            </p>
          ) : null}

          {start.error ? (
            <p role="alert" className="text-destructive text-sm">
              {taskActionMessage(start.error.message)}
            </p>
          ) : null}
        </div>

        <DialogFooter className="sm:justify-between">
          {onFullForm ? (
            <Button type="button" variant="ghost" onClick={onFullForm}>
              More options
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" disabled={!canSubmit} loading={start.isPending} onClick={submit}>
            Start task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
