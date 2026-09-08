"use client";

import type { RepositoryDto, RepositorySource } from "@solow/contracts";
import { ChevronDown, TriangleAlert, Unplug } from "lucide-react";
import { useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";
import { SeedDefaultLabelsButton } from "./seed-default-labels-button";
import {
  SectionStatus,
  SettingsCreate,
  SettingsEmpty,
  SettingsField,
  SettingsLoading,
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "./settings-shell";
import { SetupFileRows } from "./setup-file-rows";

/**
 * The one thing every setup-file pattern on this page has in common, said once.
 *
 * It used to be printed inside each repository's own setup block, which meant a Workspace with
 * seven repositories showed seven identical copies of it in a single card — 2,827px of card, and
 * the second copy onwards is text nobody reads. A warning repeated per row is banner blindness by
 * construction; the risk it describes is a property of the feature, not of any one repository.
 */
const SETUP_FILE_WARNING =
  "Files matched by a setup pattern may contain secrets. They are placed in the harness's working directory, and are kept out of the diff shown for review and out of the commit made on approval.";

/** How a Repository's holders read, for the disabled Disconnect and its confirmation. */
function describeHolders(repository: RepositoryDto): string {
  const parts: string[] = [];
  const { taskCount, projectCount, changeRequestCount } = repository.usage;
  if (repository.issueCount > 0) {
    parts.push(`${repository.issueCount} issue${repository.issueCount === 1 ? "" : "s"}`);
  }
  if (taskCount > 0) parts.push(`${taskCount} task attachment${taskCount === 1 ? "" : "s"}`);
  if (projectCount > 0) parts.push(`${projectCount} project${projectCount === 1 ? "" : "s"}`);
  if (changeRequestCount > 0) {
    parts.push(`${changeRequestCount} change request${changeRequestCount === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

/** Connect Repositories from a local clone path or a remote git URL. */
export function RepositoriesSection() {
  const utils = trpc.useUtils();
  const list = trpc.repository.list.useQuery({ ...WHOLE_PAGE });
  const [name, setName] = useState("");
  const [source, setSource] = useState<RepositorySource>("local_path");
  const [location, setLocation] = useState("");
  /** Which repository's setup block is open. One at a time — see the row comment below. */
  const [expanded, setExpanded] = useState<string | null>(null);

  const create = trpc.repository.connect.useMutation({
    onSuccess: () => {
      utils.repository.list.invalidate();
      setName("");
      setLocation("");
    },
  });

  const disconnect = trpc.repository.disconnect.useMutation({
    onSuccess: () => utils.repository.list.invalidate(),
  });

  const rows = list.data?.items ?? [];

  return (
    <SettingsSection
      caption="The checkouts a harness is allowed to work in — a local clone path or a remote git URL."
      id="repositories"
      status={
        list.isSuccess ? (
          <SectionStatus>
            {rows.length === 0
              ? "None connected"
              : `${rows.length} connected · ${rows.reduce((n, r) => n + r.setupFilePatterns.length, 0)} setup patterns`}
          </SectionStatus>
        ) : null
      }
      title="Repositories"
    >
      {list.isPending ? (
        <SettingsLoading rows={3} />
      ) : rows.length === 0 ? (
        <SettingsEmpty>
          No repositories connected yet. A harness needs one before it has anywhere to work.
        </SettingsEmpty>
      ) : (
        <SettingsRows>
          {rows.map((r) => {
            const holders = describeHolders(r);
            const open = expanded === r.id;
            return (
              <SettingsRow
                actions={
                  <>
                    {/*
                      One open at a time, and closed by default. Every repository used to render
                      its whole setup-files editor inline and unconditionally, which is what made
                      this card taller than three screens on a workspace with seven of them. The
                      count on the button is what you actually want at a glance.
                    */}
                    <Button
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : r.id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <ChevronDown className={open ? "rotate-180" : undefined} />
                      {r.setupFilePatterns.length} setup{" "}
                      {r.setupFilePatterns.length === 1 ? "file" : "files"}
                    </Button>
                    <span
                      className="inline-flex"
                      title={
                        holders
                          ? `Held by ${holders}. Detach those before disconnecting.`
                          : undefined
                      }
                    >
                      <ConfirmAction
                        confirmLabel="Disconnect"
                        description="SoloW forgets where this repository is and drops its mirrored branches and labels. Nothing on disk is touched, no commit is lost, and reconnecting the same location restores it — the mirrors are re-read on the next sync."
                        disabled={holders !== ""}
                        onConfirm={() => disconnect.mutate({ id: r.id })}
                        title={`Disconnect "${r.name}"?`}
                        trigger={
                          <Button
                            aria-label={`Disconnect ${r.name}`}
                            disabled={holders !== ""}
                            loading={disconnect.isPending && disconnect.variables?.id === r.id}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <Unplug />
                          </Button>
                        }
                      />
                    </span>
                  </>
                }
                key={r.id}
                meta={<span className="font-mono">{r.location}</span>}
                status={
                  <Badge variant="secondary">
                    {r.provider ?? (r.source === "local_path" ? "local" : "remote")}
                  </Badge>
                }
                title={r.name}
              >
                {open ? (
                  <div className="mt-3 space-y-3 rounded-lg bg-muted/30 p-3">
                    <SeedDefaultLabelsButton provider={r.provider} repositoryId={r.id} />
                    {/* Per-repository, because which files a harness needs is a property of the
                        repository, not of the Workspace (issue #52). */}
                    <SetupFileRows patterns={r.setupFilePatterns} repositoryId={r.id} />
                  </div>
                ) : null}
              </SettingsRow>
            );
          })}
        </SettingsRows>
      )}

      {disconnect.error && (
        <p className="text-destructive text-sm" role="alert">
          {disconnect.error.message}
        </p>
      )}

      <p className="flex items-start gap-2 rounded-lg border border-feedback-caution/40 bg-feedback-caution/5 px-3 py-2 text-xs leading-relaxed">
        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-feedback-caution" />
        {SETUP_FILE_WARNING}
      </p>

      <SettingsCreate
        defaultOpen={list.isSuccess && rows.length === 0}
        label="Connect a repository"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name, source, location });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <SettingsField htmlFor="repo-name" label="Name">
              <Input
                id="repo-name"
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. gate-firmware"
                required
                value={name}
              />
            </SettingsField>
            <SettingsField htmlFor="repo-source" label="Source">
              <Select onValueChange={(v) => setSource(v as RepositorySource)} value={source}>
                <SelectTrigger className="w-full" id="repo-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local_path">Local path</SelectItem>
                  <SelectItem value="remote_url">Remote URL</SelectItem>
                </SelectContent>
              </Select>
            </SettingsField>
          </div>
          <SettingsField
            hint="To mirror a repository from a connected provider instead, use Import in Integrations — that route also brings its issues across."
            htmlFor="repo-location"
            label="Location"
          >
            <Input
              id="repo-location"
              onChange={(e) => setLocation(e.target.value)}
              placeholder={
                source === "local_path" ? "/srv/repos/my-repo" : "https://github.com/org/repo.git"
              }
              required
              value={location}
            />
          </SettingsField>
          <Button loading={create.isPending} type="submit">
            Connect repository
          </Button>
        </form>
        {create.error && (
          <p className="text-destructive text-sm" role="alert">
            {create.error.message}
          </p>
        )}
      </SettingsCreate>
    </SettingsSection>
  );
}
