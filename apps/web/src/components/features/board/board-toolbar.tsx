"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/trpc/react";

/** Create-Issue and create-Task forms above the board (TASK-021 create actions). */
export function BoardToolbar() {
  const utils = trpc.useUtils();
  const issues = trpc.issue.list.useQuery({});
  const agents = trpc.profile.agent.list.useQuery({});
  const executors = trpc.profile.executor.list.useQuery({});
  const repos = trpc.repository.list.useQuery({});

  const [issueTitle, setIssueTitle] = useState("");
  const createIssue = trpc.issue.create.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
      setIssueTitle("");
    },
  });

  const [taskTitle, setTaskTitle] = useState("");
  const [issueId, setIssueId] = useState("");
  const [agentProfileId, setAgentProfileId] = useState("");
  const [executorProfileId, setExecutorProfileId] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const createTask = trpc.task.create.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
      setTaskTitle("");
    },
  });

  const canCreateTask =
    (issues.data?.length ?? 0) > 0 &&
    (agents.data?.length ?? 0) > 0 &&
    (executors.data?.length ?? 0) > 0 &&
    (repos.data?.length ?? 0) > 0 &&
    Boolean(issueId && agentProfileId && executorProfileId && repositoryId && taskTitle);

  return (
    <Card className="mx-4 mt-4 py-4">
      <CardContent className="flex flex-col gap-3 px-4">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            createIssue.mutate({ title: issueTitle });
          }}
        >
          <Input
            aria-label="Issue title"
            placeholder="New issue title"
            className="max-w-xs"
            value={issueTitle}
            onChange={(e) => setIssueTitle(e.target.value)}
            required
          />
          <Button type="submit" variant="secondary" disabled={createIssue.isPending}>
            <Plus /> Add issue
          </Button>
        </form>

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            createTask.mutate({
              issueId,
              title: taskTitle,
              agentProfileId,
              executorProfileId,
              repositoryId,
            });
          }}
        >
          <Input
            aria-label="Task title"
            placeholder="New task title"
            className="max-w-xs"
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.target.value)}
            required
          />
          <Select value={issueId} onValueChange={setIssueId}>
            <SelectTrigger aria-label="Issue" className="w-40">
              <SelectValue placeholder="Issue…" />
            </SelectTrigger>
            <SelectContent>
              {(issues.data ?? []).map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={agentProfileId} onValueChange={setAgentProfileId}>
            <SelectTrigger aria-label="Agent profile" className="w-40">
              <SelectValue placeholder="Agent…" />
            </SelectTrigger>
            <SelectContent>
              {(agents.data ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={executorProfileId} onValueChange={setExecutorProfileId}>
            <SelectTrigger aria-label="Executor profile" className="w-40">
              <SelectValue placeholder="Executor…" />
            </SelectTrigger>
            <SelectContent>
              {(executors.data ?? []).map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={repositoryId} onValueChange={setRepositoryId}>
            <SelectTrigger aria-label="Repository" className="w-40">
              <SelectValue placeholder="Repository…" />
            </SelectTrigger>
            <SelectContent>
              {(repos.data ?? []).map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={createTask.isPending || !canCreateTask}>
            <Plus /> Add task
          </Button>
        </form>

        {!canCreateTask && (
          <p className="text-muted-foreground text-xs">
            Configure a secret, agent/executor profile, and repository in Settings, then fill every
            field to create a task.
          </p>
        )}
        {createTask.error && (
          <p className="text-destructive text-sm" role="alert">
            {createTask.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
