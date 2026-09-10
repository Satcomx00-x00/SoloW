"use client";

import type { WorkflowDto } from "@solow/contracts";
import {
  WORKFLOW_STORE,
  WORKFLOW_STORE_CATEGORIES,
  type WorkflowStoreCategory,
  type WorkflowStoreEntry,
  workflowStoreSkills,
} from "@solow/core";
import { Check, ExternalLink, Search, Workflow as WorkflowIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
 * The Workflow store (spec F03): `@solow/core`'s catalog of pipelines, installed with a click.
 * The dialog's one question is which Harness Profile the Steps run on — the catalog has no
 * opinion, and the canvas can re-point any Step afterwards. The Skills an entry brings are
 * listed on its card, because they are library rows the install will write; the reply says
 * which were written and which the library already held.
 *
 * "Installed" is decided by name against the list as it is now, the way the MCP store does it —
 * but a pipeline, unlike a server, is worth installing twice (to keep a variant), so the button
 * stays and the second copy gets a suffixed name.
 */
export function WorkflowStoreDialog({
  trigger,
  installed,
}: {
  trigger: ReactNode;
  installed: readonly WorkflowDto[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<WorkflowStoreCategory | "all">("all");
  const [profileId, setProfileId] = useState("");

  const profiles = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE }, { enabled: open });
  const profileItems = profiles.data?.items ?? [];
  // The first profile by name is what the import would fall back to anyway; pre-selecting it
  // makes a one-profile Workspace a one-click install.
  useEffect(() => {
    if (!profileId && profileItems[0]) setProfileId(profileItems[0].id);
  }, [profileId, profileItems]);

  const installedNames = useMemo(
    () => new Set(installed.map((w) => w.name.trim().toLowerCase())),
    [installed],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return WORKFLOW_STORE.filter(
      (entry) =>
        (category === "all" || entry.category === category) &&
        (!q ||
          `${entry.title} ${entry.description} ${entry.vendor} ${entry.steps.map((s) => s.name).join(" ")}`
            .toLowerCase()
            .includes(q)),
    );
  }, [query, category]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Workflow store</DialogTitle>
          <DialogDescription>
            Ready-made pipelines, one click each. Every step runs on the harness you pick here;
            re-point any of them on the canvas afterwards.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search
                aria-hidden
                className="-translate-y-1/2 absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
              />
              <Input
                aria-label="Search the store"
                placeholder="Search pipelines…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="workflow-store-profile" className="text-muted-foreground text-xs">
                Runs on
              </Label>
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger id="workflow-store-profile" size="sm" className="min-w-40 text-xs">
                  <SelectValue placeholder="Pick a harness profile" />
                </SelectTrigger>
                <SelectContent>
                  {profileItems.length === 0 && (
                    <p className="px-2 py-1.5 text-muted-foreground text-xs">
                      No harness profiles yet — add one in Settings → Harnesses.
                    </p>
                  )}
                  {profileItems.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            <CategoryChip active={category === "all"} onClick={() => setCategory("all")}>
              All
            </CategoryChip>
            {WORKFLOW_STORE_CATEGORIES.map((c) => (
              <CategoryChip key={c.id} active={category === c.id} onClick={() => setCategory(c.id)}>
                {c.label}
              </CategoryChip>
            ))}
          </div>

          {shown.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
              Nothing in the store matches.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2" aria-label="Store entries">
              {shown.map((entry) => (
                <StoreCard
                  key={entry.id}
                  entry={entry}
                  profileId={profileId}
                  installed={installedNames.has(entry.title.toLowerCase())}
                  onInstalled={() => setOpen(false)}
                />
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        active
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

const CATEGORY_LABEL = new Map(WORKFLOW_STORE_CATEGORIES.map((c) => [c.id, c.label]));

function StoreCard({
  entry,
  profileId,
  installed,
  onInstalled,
}: {
  entry: WorkflowStoreEntry;
  profileId: string;
  installed: boolean;
  onInstalled: () => void;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const skills = workflowStoreSkills(entry);
  const gates = entry.steps.filter((s) => s.gate === "human").length;

  const install = trpc.workflow.installFromStore.useMutation({
    onSuccess: (result) => {
      utils.workflow.list.invalidate();
      // The Steps name Skills the install may just have written; the library and every
      // Step's picker read that list.
      if (result.createdSkills.length > 0) utils.library.skill.list.invalidate();
      onInstalled();
      router.push(`/workflows/${result.workflow.id}`);
    },
  });

  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-card/40 p-3">
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground"
          aria-hidden
        >
          <WorkflowIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-sm">{entry.title}</span>
            <Badge variant="outline" className="text-2xs">
              {CATEGORY_LABEL.get(entry.category) ?? entry.category}
            </Badge>
          </div>
          <p className="text-muted-foreground text-xs">{entry.description}</p>
        </div>
      </div>

      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 font-mono text-2xs text-muted-foreground/80">
        {entry.steps.map((step, index) => (
          <li key={step.name} className="inline-flex items-center gap-1">
            {index > 0 && <span aria-hidden>→</span>}
            <span className={step.gate === "human" ? "text-foreground" : undefined}>
              {step.name}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-2xs text-muted-foreground">
        {entry.steps.length === 1 ? "1 step" : `${entry.steps.length} steps`}
        {gates > 0 && ` · ${gates === 1 ? "1 human gate" : `${gates} human gates`}`}
        {skills.length > 0 && (
          <>
            {" · brings "}
            <span className="font-mono">{skills.map((s) => s.name).join(", ")}</span>
          </>
        )}
      </p>

      {install.error && (
        <p className="text-feedback-error text-xs" role="alert">
          {install.error.message}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2">
        <a
          href={entry.homepage}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
        >
          {entry.vendor}
          <ExternalLink aria-hidden className="size-3" />
        </a>
        <div className="flex items-center gap-2">
          {installed && (
            <span className="inline-flex items-center gap-1 text-feedback-ok text-xs">
              <Check aria-hidden className="size-3.5" />
              Installed
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={install.isPending}
            disabled={!profileId}
            aria-label={`Install ${entry.title}`}
            onClick={() => install.mutate({ entryId: entry.id, harnessProfileId: profileId })}
          >
            {installed ? "Install again" : "Install"}
          </Button>
        </div>
      </div>
    </li>
  );
}
