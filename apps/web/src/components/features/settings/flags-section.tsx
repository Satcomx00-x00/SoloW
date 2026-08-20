"use client";

import type { FlagDto } from "@gatecontrol/contracts";
import { useState } from "react";
import { ConfirmDialog } from "@/components/features/confirm-action";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { trpc } from "@/trpc/react";

/**
 * Feature flags, toggleable from Settings (issue #21).
 *
 * Every registered flag is listed here, not just the ones already turned on — that is what
 * makes this the discovery surface for what GateControl can do beyond the core loop, the same
 * way status-bar-section.tsx lists every registered status item rather than only the visible
 * ones. Reuses the Checkbox + Label row idiom from that section rather than introducing a new
 * Switch primitive: none exists in `components/ui` yet, and issue #76 is the tracked owner of
 * adding it — a second one landing here risks colliding with that work.
 *
 * `ff-core-program` gets a confirmation on its way OFF, not its way on: turning it off locks the
 * caller out of the core Task loop (and most of the rest of this Settings page, since every
 * other procedure requires it) until it is turned back on, with no in-app path back — only
 * `bun run flag enable ff-core-program` from the machine running the instance. Every other flag
 * toggles immediately; none of them can strand the caller outside the app that would let them
 * undo it.
 */
export function FlagsSection() {
  const utils = trpc.useUtils();
  const list = trpc.flag.list.useQuery({});
  const set = trpc.flag.set.useMutation({
    onSuccess: () => utils.flag.list.invalidate(),
  });
  const [pendingLockout, setPendingLockout] = useState<FlagDto | null>(null);

  function toggle(flag: FlagDto, enabled: boolean) {
    if (flag.key === "ff-core-program" && !enabled) {
      setPendingLockout(flag);
      return;
    }
    set.mutate({ key: flag.key, enabled });
  }

  return (
    <Card id="flags" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Feature flags</CardTitle>
        <CardDescription>
          Every flag ships OFF until turned on here for this Workspace. Turning a flag off is a kill
          switch — it takes effect immediately for everyone signed into this Workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.isSuccess && (
          <ul className="divide-y rounded-md border">
            {list.data.map((flag) => {
              const inputId = `flag-${flag.key}`;
              return (
                <li key={flag.key} className="flex items-start gap-3 px-3 py-2">
                  <Checkbox
                    id={inputId}
                    checked={flag.enabled}
                    onCheckedChange={(checked) => toggle(flag, checked === true)}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <Label htmlFor={inputId} className="font-normal">
                      {flag.key}
                    </Label>
                    <p className="text-muted-foreground text-sm">{flag.description}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {set.error && (
          <p className="text-destructive text-sm" role="alert">
            {set.error.message}
          </p>
        )}
      </CardContent>
      <ConfirmDialog
        open={pendingLockout !== null}
        onOpenChange={(open) => {
          if (!open) setPendingLockout(null);
        }}
        title="Turn off the core Task loop?"
        description="This locks out Issue → run agent → review → approve for everyone in this Workspace — including most of the rest of this Settings page — until it is turned back on. There is no in-app undo: recovery is `bun run flag enable ff-core-program` on the machine running this instance."
        confirmLabel="Turn off"
        onConfirm={() => {
          if (pendingLockout) set.mutate({ key: pendingLockout.key, enabled: false });
          setPendingLockout(null);
        }}
      />
    </Card>
  );
}
