"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/trpc/react";
import { SectionStatus, SettingsField, SettingsLoading, SettingsSection } from "./settings-shell";

/**
 * The Workspace, given a screen (2026-08-28).
 *
 * It is the tenant key every table is scoped by and every procedure re-checks (Principle V), and
 * until now it appeared in the product as a few words of grey text in a breadcrumb — unnamed by
 * its Owner, unreadable, unchangeable. Everything else in Settings belongs *to* this, so it
 * belongs above them rather than being the one thing with no page.
 *
 * The id is shown because it is the value that appears in logs, in `openapi.json` examples and
 * in every support question about which tenant a row belongs to; copying it out of a log line is
 * worse than reading it here.
 */
export function WorkspaceSection() {
  const utils = trpc.useUtils();
  const router = useRouter();
  const workspace = trpc.workspace.get.useQuery();
  const [draft, setDraft] = useState("");

  // Seeded from the server once it arrives, then owned by the field: overwriting on every
  // render would fight anyone mid-edit whenever a background refetch landed.
  useEffect(() => {
    if (workspace.data) setDraft(workspace.data.name);
  }, [workspace.data]);

  const rename = trpc.workspace.rename.useMutation({
    onSuccess: () => {
      utils.workspace.get.invalidate();
      utils.workspace.setup.invalidate();
      /*
       * The shell renders the name in a server component, so the breadcrumb keeps the old one
       * until the route re-renders — a header disagreeing with the field that just changed it
       * reads as the rename having failed.
       *
       * `router.refresh()`, not `window.location.reload()`. The reload did fix the breadcrumb, and
       * it also threw away every other client state in the group: a half-typed secret four hundred
       * pixels below, an open create form, a selected executor. Renaming a Workspace is not a
       * reason to lose someone's unsaved work. `refresh` re-fetches the server components in
       * place, which is exactly — and only — what was stale.
       */
      router.refresh();
    },
  });

  const ws = workspace.data;
  const dirty = ws !== undefined && draft.trim() !== ws.name && draft.trim().length > 0;

  return (
    <SettingsSection
      caption="Everything in SoloW belongs to a workspace: its issues, projects, secrets, harness profiles and the repositories harnesses are allowed to work in."
      id="workspace"
      status={
        ws ? (
          <SectionStatus>Created {new Date(ws.createdAt).toLocaleDateString()}</SectionStatus>
        ) : null
      }
      title="Workspace"
    >
      {ws === undefined ? (
        <SettingsLoading rows={1} />
      ) : (
        <>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) rename.mutate({ name: draft.trim() });
            }}
          >
            <SettingsField htmlFor="workspace-name" label="Name">
              <Input
                className="w-72"
                id="workspace-name"
                maxLength={80}
                onChange={(e) => setDraft(e.target.value)}
                value={draft}
              />
            </SettingsField>
            <Button disabled={!dirty} loading={rename.isPending} type="submit">
              Rename
            </Button>
          </form>
          {rename.error && (
            <p className="text-destructive text-sm" role="alert">
              {rename.error.message}
            </p>
          )}

          <dl className="grid gap-2 border-t pt-4 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">Identifier</dt>
            <dd className="font-mono text-xs">{ws.id}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd className="tabular-nums">{new Date(ws.createdAt).toLocaleString()}</dd>
          </dl>
        </>
      )}
    </SettingsSection>
  );
}
