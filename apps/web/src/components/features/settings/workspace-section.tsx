"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/trpc/react";

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
      // The shell renders the name in a server component, so the breadcrumb keeps the old one
      // until the route re-renders — a header disagreeing with the field that just changed it
      // reads as the rename having failed.
      window.location.reload();
    },
  });

  if (!workspace.data) {
    return (
      <Card id="workspace" className="scroll-mt-16">
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-64" />
        </CardContent>
      </Card>
    );
  }

  const ws = workspace.data;
  const dirty = draft.trim() !== ws.name && draft.trim().length > 0;

  return (
    <Card id="workspace" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <CardDescription>
          Everything in SoloW belongs to a workspace: its issues, projects, secrets, agent profiles
          and the repositories agents are allowed to work in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) rename.mutate({ name: draft.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-72"
              maxLength={80}
            />
          </div>
          <Button type="submit" disabled={!dirty} loading={rename.isPending}>
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
          <dd>{new Date(ws.createdAt).toLocaleString()}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
