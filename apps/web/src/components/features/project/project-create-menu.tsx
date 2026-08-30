"use client";

import type { CreatedEpicDto, CreatedProviderIssueDto, ProjectDto } from "@solow/contracts";
import { ChevronDown, Milestone, Plus, SquarePen } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";
import { CreateEpicDialog } from "./create-epic-dialog";
import { CreateIssueDialog } from "./create-issue-dialog";

/**
 * The `＋ New` split-button (spec F23a Part 1), top-right of the Project toolbar.
 *
 * Its two entries are the two authoring actions a planning table needs but F23 never had. Both
 * follow the same rule when they cannot be offered: the entry stays **present and disabled with
 * the reason** rather than vanishing (F23 FR-5 / Decision 0016 — a capability difference is
 * stated, not hidden), which is why the gating below produces a reason string rather than a
 * boolean the menu could silently act on.
 *
 * Extracted from `project-view.tsx` on purpose: the gating is pure and worth testing on its own,
 * and this keeps the create workflow out of an already-large file that other changes touch.
 */

/** Just the manifest fields the epic gate reads — kept minimal so the pure test needs no full DTO. */
interface ManifestLike {
  id: string;
  name: string;
  // `| undefined` explicitly, to accept `ProviderManifestDto` under `exactOptionalPropertyTypes`.
  issueCreates?: { epics: boolean } | undefined;
}
interface IntegrationLike {
  id: string;
  provider: string;
}
interface RepoLike {
  integrationId: string | null;
}

/**
 * Can this Project originate a provider Issue, and if not, why not?
 *
 * "At least one provider-backed repository" is the whole test: a repository with no `integrationId`
 * is a local path with nothing to POST to. The reason names the fix so a project of only local
 * repositories does not read as a broken button.
 */
export function issueItemState(repos: readonly RepoLike[]): {
  enabled: boolean;
  reason: string | null;
} {
  const hasProviderRepo = repos.some((r) => r.integrationId !== null);
  return hasProviderRepo
    ? { enabled: true, reason: null }
    : {
        enabled: false,
        reason:
          "This project has no provider-backed repository — connect a GitHub or GitLab repository to create issues.",
      };
}

/**
 * Can this Project's provider create an Epic, and if not, why not?
 *
 * Decided against the **manifest**, never the provider's name: the Project names an Integration,
 * the Integration names a provider, and the provider's manifest declares `issueCreates.epics`. A
 * local Project short-circuits — it has no provider at all. The `integrationId` is threaded back
 * out so the epic dialog can address the same connection the gate approved.
 */
export function epicItemState(args: {
  integrationId: string | null;
  integrations: readonly IntegrationLike[];
  manifests: readonly ManifestLike[];
}): { enabled: boolean; reason: string | null; integrationId: string | null } {
  const { integrationId, integrations, manifests } = args;
  if (integrationId === null) {
    return {
      enabled: false,
      reason: "Epics are a GitLab group feature — this project has no provider behind it.",
      integrationId: null,
    };
  }
  const provider = integrations.find((i) => i.id === integrationId)?.provider ?? null;
  const manifest = provider ? (manifests.find((m) => m.id === provider) ?? null) : null;
  if (!manifest) {
    return {
      enabled: false,
      reason: "This project's provider has not reported its capabilities yet.",
      integrationId,
    };
  }
  if (!manifest.issueCreates?.epics) {
    return {
      enabled: false,
      reason: `${manifest.name} does not support epics.`,
      integrationId,
    };
  }
  return { enabled: true, reason: null, integrationId };
}

export function ProjectCreateMenu({ project }: { project: ProjectDto }) {
  const [dialog, setDialog] = useState<"issue" | "epic" | null>(null);

  const repos = trpc.repository.list.useQuery({ ...WHOLE_PAGE });
  // Behind the integrations flag; `retry: false` so a Workspace with the flag off settles quickly
  // to "no manifests", which the epic gate reads as unsupported — the correct answer there.
  const integrations = trpc.integration.list.useQuery({}, { retry: false });
  const manifests = trpc.integration.providers.useQuery({}, { retry: false });

  const issueState = issueItemState(repos.data?.items ?? []);
  const epicState = epicItemState({
    integrationId: project.integrationId,
    integrations: integrations.data ?? [],
    manifests: manifests.data ?? [],
  });

  const onCreated = (_created: CreatedProviderIssueDto | CreatedEpicDto) => {
    // The row surfaces through the dialogs' own invalidations; nothing more to do here yet. Kept
    // as a seam for the "select and scroll to the new row" step (F23a Action 5) the table will grow.
    setDialog(null);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" className="gap-1">
            <Plus aria-hidden /> New
            <ChevronDown className="size-3 opacity-70" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-2xs">Create on the provider</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={!issueState.enabled}
            title={issueState.reason ?? undefined}
            onSelect={() => setDialog("issue")}
          >
            <SquarePen aria-hidden /> New issue
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!epicState.enabled}
            title={epicState.reason ?? undefined}
            onSelect={() => setDialog("epic")}
          >
            <Milestone aria-hidden /> New epic
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Mounted only while open, so each dialog starts from empty form state every time — the same
          reason the shell's `CreateMenu` keys its dialogs on open. */}
      {dialog === "issue" && (
        <CreateIssueDialog
          projectId={project.id}
          epicsSupported={epicState.enabled}
          open
          onOpenChange={(next) => !next && setDialog(null)}
          onCreated={onCreated}
        />
      )}
      {dialog === "epic" && epicState.integrationId && (
        <CreateEpicDialog
          projectId={project.id}
          integrationId={epicState.integrationId}
          open
          onOpenChange={(next) => !next && setDialog(null)}
          onCreated={onCreated}
        />
      )}
    </>
  );
}
