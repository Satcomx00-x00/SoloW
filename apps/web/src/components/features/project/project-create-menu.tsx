"use client";

import type {
  CreatedEpicDto,
  CreatedProviderIssueDto,
  ParentPlanningContainer,
  ProjectDto,
} from "@solow/contracts";
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
import { CreateIssueDialog } from "./create-issue-dialog";
import { CreateParentItemDialog } from "./create-parent-item-dialog";

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

/** Just the manifest fields the gates read — kept minimal so the pure test needs no full DTO. */
interface ManifestLike {
  id: string;
  name: string;
  // `| undefined` explicitly, to accept `ProviderManifestDto` under `exactOptionalPropertyTypes`.
  issueCreates?:
    | {
        epics: boolean;
        parentPlanningItem?: { container: ParentPlanningContainer; noun: string } | undefined;
      }
    | undefined;
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
 * Can this Project's provider **originate a parent planning item**, where does it live, and what
 * does that provider call it?
 *
 * Decided against the **manifest**, never the provider's name: the Project names an Integration,
 * the Integration names a provider, and the provider's manifest declares
 * `issueCreates.parentPlanningItem`. A local Project short-circuits — it has no provider at all.
 * The `integrationId` is threaded back out so the dialog can address the same connection the gate
 * approved, and `container`/`noun` so it can ask for the right thing and call it the right name.
 *
 * `epicsSupported` is the *other* question, computed independently of everything above and
 * returned beside it. A provider could have epic objects to nest issues under without being able
 * to originate one from this menu, and one can originate a parent with no epic object anywhere
 * (GitHub). Collapsing the two would either lock a provider out of the menu or silently drop the
 * issue compose form's Parent-epic picker — which is why it is a second field and not a re-reading
 * of `enabled`.
 */
export function parentPlanningItemState(args: {
  integrationId: string | null;
  integrations: readonly IntegrationLike[];
  manifests: readonly ManifestLike[];
}): {
  enabled: boolean;
  reason: string | null;
  integrationId: string | null;
  container: ParentPlanningContainer | null;
  noun: string | null;
  epicsSupported: boolean;
} {
  const { integrationId, integrations, manifests } = args;
  const provider =
    integrationId === null
      ? null
      : (integrations.find((i) => i.id === integrationId)?.provider ?? null);
  const manifest = provider ? (manifests.find((m) => m.id === provider) ?? null) : null;
  // Read off the manifest directly rather than from the branches below, so the epic picker's fate
  // never depends on whether this menu entry happened to be enabled.
  const epicsSupported = manifest?.issueCreates?.epics === true;
  const blocked = (reason: string) => ({
    enabled: false,
    reason,
    integrationId,
    container: null,
    noun: null,
    epicsSupported,
  });

  if (integrationId === null) {
    // Deliberately says nothing about epics or about GitLab: a Project with no provider behind it
    // is missing the connection, not a particular provider's feature.
    return blocked(
      "This project has no provider behind it, so there is nothing to create a parent planning item on.",
    );
  }
  if (!manifest) return blocked("This project's provider has not reported its capabilities yet.");

  const declared = manifest.issueCreates?.parentPlanningItem;
  // Absent is "this provider cannot originate one", and the reason names *that* provider — the
  // F23 FR-5 rule that a stated reason has to be true of the thing the operator is looking at.
  if (!declared) return blocked(`${manifest.name} cannot originate a parent planning item.`);

  return {
    enabled: true,
    reason: null,
    integrationId,
    container: declared.container,
    noun: declared.noun,
    epicsSupported,
  };
}

export function ProjectCreateMenu({ project }: { project: ProjectDto }) {
  const [dialog, setDialog] = useState<"issue" | "parent" | null>(null);

  const repos = trpc.repository.list.useQuery({ ...WHOLE_PAGE });
  // Behind the integrations flag; `retry: false` so a Workspace with the flag off settles quickly
  // to "no manifests", which both gates read as unsupported — the correct answer there.
  const integrations = trpc.integration.list.useQuery({}, { retry: false });
  const manifests = trpc.integration.providers.useQuery({}, { retry: false });

  const issueState = issueItemState(repos.data?.items ?? []);
  const parentState = parentPlanningItemState({
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
            disabled={!parentState.enabled}
            title={parentState.reason ?? undefined}
            onSelect={() => setDialog("parent")}
          >
            {/* The provider's own word for the thing, never a fixed "epic": on GitHub this entry
                creates an issue, and calling it an epic would be the label lying about the object.
                The fallback is only ever seen disabled, where there is no provider to ask. */}
            <Milestone aria-hidden /> New {parentState.noun ?? "parent item"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Mounted only while open, so each dialog starts from empty form state every time — the
          same reason every other create surface in the app keys its dialogs on open, rather than
          rendering them always and reaching for a reset path. */}
      {dialog === "issue" && (
        <CreateIssueDialog
          projectId={project.id}
          /* The `epics` flag alone, not this menu's gate: the picker asks whether there are epics
             to nest an Issue under, which is a different question from whether one can be made. */
          epicsSupported={parentState.epicsSupported}
          open
          onOpenChange={(next) => !next && setDialog(null)}
          onCreated={onCreated}
        />
      )}
      {dialog === "parent" && parentState.integrationId && parentState.container && (
        <CreateParentItemDialog
          projectId={project.id}
          integrationId={parentState.integrationId}
          container={parentState.container}
          noun={parentState.noun ?? "parent item"}
          open
          onOpenChange={(next) => !next && setDialog(null)}
          onCreated={onCreated}
        />
      )}
    </>
  );
}
