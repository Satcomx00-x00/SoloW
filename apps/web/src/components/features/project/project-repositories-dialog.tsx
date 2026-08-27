"use client";

import { FolderGit2, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { useRowRefresh } from "@/components/features/project/row-refresh";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";

/**
 * A local Project's membership, made and unmade (issue #15's reversal, applied to Projects — user
 * request 2026-08-27).
 *
 * A mirrored Project's rows come from a sync; a local one has no sync to run, so this is the
 * whole of how it gets rows at all — register a Repository, and every Issue it already holds (and
 * every one it gets later) becomes a member. Detaching is the same decision reversed: it removes
 * this Project's membership rows, never the Repository or its Issues.
 */
export function ProjectRepositoriesDialog({
  projectId,
  trigger,
}: {
  projectId: string;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const refreshRows = useRowRefresh();

  const attached = trpc.project.repositories.useQuery({ projectId }, { enabled: open });
  const allRepositories = trpc.repository.list.useQuery({ ...WHOLE_PAGE }, { enabled: open });

  const attachedIds = useMemo(
    () => new Set((attached.data ?? []).map((r) => r.repositoryId)),
    [attached.data],
  );
  const unattached = useMemo(
    () => (allRepositories.data?.items ?? []).filter((r) => !attachedIds.has(r.id)),
    [allRepositories.data, attachedIds],
  );

  const invalidateAfterMembershipChange = () => {
    void utils.project.repositories.invalidate({ projectId });
    void utils.project.get.invalidate({ projectId });
    // The table's own row source, not `project.repositories` again — attaching or detaching a
    // Repository changes which Issues this Project holds, and that is what `useRowRefresh` names.
    refreshRows();
  };

  const attach = trpc.project.attachRepository.useMutation({
    onSuccess: invalidateAfterMembershipChange,
  });
  const detach = trpc.project.detachRepository.useMutation({
    onSuccess: invalidateAfterMembershipChange,
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Repositories</DialogTitle>
          <DialogDescription>
            A local Project has no sync to fill it — a Repository registered here is what puts
            Issues in it, and every Issue that Repository gets later arrives the same way.
          </DialogDescription>
        </DialogHeader>

        {attached.isPending ? (
          <p className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
            <Loader2 aria-hidden className="size-4 animate-spin" /> Loading…
          </p>
        ) : (attached.data ?? []).length === 0 ? (
          <p className="py-4 text-muted-foreground text-sm">
            No repository is registered yet, so this Project has no Issues — register one below to
            give it its first.
          </p>
        ) : (
          <ul className="divide-y">
            {(attached.data ?? []).map((repo) => (
              <li key={repo.id} className="flex items-center gap-3 py-2">
                <FolderGit2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{repo.repositoryName}</span>
                <Badge variant="outline" className="font-mono tabular-nums">
                  {repo.issueCount} issue{repo.issueCount === 1 ? "" : "s"}
                </Badge>
                {repo.issueCount > 0 ? (
                  <ConfirmAction
                    trigger={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Detach ${repo.repositoryName}`}
                        disabled={detach.isPending}
                      >
                        <X aria-hidden />
                      </Button>
                    }
                    title={`Detach "${repo.repositoryName}"?`}
                    description={`This removes ${repo.issueCount} issue${repo.issueCount === 1 ? "" : "s"} from this Project's view — the issues themselves are untouched, only their membership here goes.`}
                    confirmLabel="Detach"
                    onConfirm={() => detach.mutate({ projectId, repositoryId: repo.repositoryId })}
                  />
                ) : (
                  // Nothing to lose: an empty Repository leaves no row behind, so a confirmation
                  // would be friction with no purpose.
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Detach ${repo.repositoryName}`}
                    disabled={detach.isPending}
                    onClick={() => detach.mutate({ projectId, repositoryId: repo.repositoryId })}
                  >
                    <X aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-2 border-t pt-3">
          <Label htmlFor="attach-repository" className="text-2xs text-muted-foreground">
            Attach a repository
          </Label>
          <Select
            value=""
            disabled={unattached.length === 0 || attach.isPending}
            onValueChange={(repositoryId) => attach.mutate({ projectId, repositoryId })}
          >
            <SelectTrigger className="w-full" id="attach-repository">
              <SelectValue
                placeholder={
                  unattached.length === 0
                    ? "Every repository is already registered"
                    : "Register a repository"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {unattached.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  {repo.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {attach.error && <p className="text-2xs text-state-failed">{attach.error.message}</p>}
          {detach.error && <p className="text-2xs text-state-failed">{detach.error.message}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
