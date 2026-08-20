"use client";

import type { ExternalIssuePreviewDto } from "@gatecontrol/contracts";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/trpc/react";

/**
 * Import Issues from a linked GitHub/GitLab repository (issue #15 AC-2). A repository shows up
 * here once it has been linked to an Integration in Settings → Integrations. This is the
 * provider-backed path; `IssueFormDialog` is the other one — the issue #15 reversal brought
 * back a free-text Issue form alongside this, for a locally created Issue with no provider
 * behind it (packages/contracts/src/issue.ts documents the reversal).
 */
export function ImportIssuesDialog() {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const repos = trpc.repository.list.useQuery({}, { enabled: open });
  const linkedRepos = (repos.data ?? []).filter((r) => r.integrationId);
  const [repositoryId, setRepositoryId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!repositoryId && linkedRepos[0]) setRepositoryId(linkedRepos[0].id);
  }, [repositoryId, linkedRepos]);

  const external = trpc.integration.listExternalIssues.useQuery(
    { repositoryId },
    { enabled: open && repositoryId.length > 0 },
  );

  const importIssues = trpc.integration.importIssues.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
      setSelected(new Set());
      setOpen(false);
    },
  });

  /**
   * Switching repositories must drop the previous selection — the checked externalIds are only
   * meaningful within the repository that produced them, and importIssues sends whatever is
   * still checked to *this* repositoryId regardless of which repository the user meant it for
   * (adversarial review, pre-merge).
   */
  const changeRepository = (id: string) => {
    setRepositoryId(id);
    setSelected(new Set());
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const importable = (external.data ?? []).filter(
    (i: ExternalIssuePreviewDto) => !i.alreadyImported,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Closing without importing must not leave a stale selection for next time either.
        if (!next) setSelected(new Set());
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-muted-foreground hover:text-foreground"
        >
          <Download /> Import issues
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import issues</DialogTitle>
          <DialogDescription>
            Every Issue in GateControl comes from a connected GitHub or GitLab repository — select
            which ones to bring in.
          </DialogDescription>
        </DialogHeader>

        {repos.isSuccess && linkedRepos.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No repository is linked to an integration yet. Connect GitHub or GitLab and link a
            repository in Settings → Integrations first.
          </p>
        )}

        {linkedRepos.length > 0 && (
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="import-repo">Repository</Label>
              <Select value={repositoryId} onValueChange={changeRepository}>
                <SelectTrigger className="w-full" id="import-repo">
                  <SelectValue placeholder="Select a repository" />
                </SelectTrigger>
                <SelectContent>
                  {linkedRepos.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name} · {r.externalFullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {external.isSuccess && (
              <ScrollArea className="h-72 rounded-md border">
                <ul className="divide-y">
                  {(external.data ?? []).map((i) => (
                    <li key={i.externalId} className="flex items-start gap-3 p-3">
                      <Checkbox
                        checked={selected.has(i.externalId)}
                        disabled={i.alreadyImported}
                        onCheckedChange={() => toggle(i.externalId)}
                        aria-label={`Import ${i.title}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          #{i.number} {i.title}
                        </p>
                        <p className="text-muted-foreground text-xs">{i.state}</p>
                      </div>
                      {i.alreadyImported && (
                        <Badge variant="secondary" className="shrink-0">
                          Already imported
                        </Badge>
                      )}
                    </li>
                  ))}
                  {(external.data ?? []).length === 0 && (
                    <li className="p-3 text-muted-foreground text-sm">
                      No open issues found on this repository.
                    </li>
                  )}
                </ul>
              </ScrollArea>
            )}

            {importIssues.error && (
              <p className="text-destructive text-sm" role="alert">
                {importIssues.error.message}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                loading={importIssues.isPending}
                disabled={selected.size === 0 || importable.length === 0}
                onClick={() =>
                  importIssues.mutate({ repositoryId, externalIds: Array.from(selected) })
                }
              >
                Import selected ({selected.size})
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
