"use client";

import { FolderPlus, Plus } from "lucide-react";
import { ConnectRepositoryDialog } from "@/components/features/issues/connect-repository-dialog";
import { IssueFormDialog } from "@/components/features/issues/issue-form-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { trpc } from "@/trpc/react";

/**
 * The Backlog column's two header actions (user report: issues and repositories should be
 * creatable straight from the board, not only from a separate page or Settings). Glyph-only
 * ghost buttons matching the column header's compact aesthetic — `ColumnHeader`'s icon and label
 * already carry the same treatment.
 */
export function BacklogActions() {
  const utils = trpc.useUtils();
  return (
    <TooltipProvider delayDuration={200}>
      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <ConnectRepositoryDialog
                trigger={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Connect a repository"
                  >
                    <FolderPlus />
                  </Button>
                }
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>Connect a repository</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <IssueFormDialog
                onSuccess={() => utils.issue.list.invalidate()}
                trigger={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="New issue"
                  >
                    <Plus />
                  </Button>
                }
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>New issue</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
