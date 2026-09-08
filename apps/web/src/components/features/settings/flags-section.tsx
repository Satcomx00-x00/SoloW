"use client";

import type { FlagDto } from "@solow/contracts";
import { useState } from "react";
import { ConfirmDialog } from "@/components/features/confirm-action";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { trpc } from "@/trpc/react";
import { SectionStatus, SettingsEmpty, SettingsLoading, SettingsSection } from "./settings-shell";

/**
 * Feature flags, toggleable from Settings (issue #21).
 *
 * Every registered flag is listed here, not just the ones already turned on — that is what
 * makes this the discovery surface for what SoloW can do beyond the core loop, the same
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
/**
 * A flag key, read as a name.
 *
 * The registry stores `ff-core-program` and nothing friendlier, and that key was the visible
 * `<Label>` on every row — so the switch that locks an Owner out of the core loop looked exactly
 * like the one that adds tappable widgets. Derived rather than added to the contract: the key is
 * the only identity a flag has, and a second stored name would be a second thing to keep in sync
 * for no gain. The key itself stays on the row, in mono, because it is the argument you type.
 */
function flagLabel(key: string): string {
  const words = key.replace(/^ff-/, "").split("-");
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

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

  const flags = list.data ?? [];
  const on = flags.filter((f) => f.enabled).length;

  return (
    <SettingsSection
      caption="Every flag ships OFF until turned on here for this Workspace. Turning a flag off is a kill switch — it takes effect immediately for everyone signed into this Workspace."
      id="flags"
      status={
        list.isSuccess ? (
          <SectionStatus tone={on > 0 ? "active" : "idle"}>
            {`${on} of ${flags.length} on`}
          </SectionStatus>
        ) : null
      }
      title="Feature flags"
    >
      {list.isPending ? (
        <SettingsLoading rows={3} />
      ) : flags.length === 0 ? (
        // It used to render nothing at all here — a card with a title and a void, which reads as
        // a surface that failed rather than one with nothing to show.
        <SettingsEmpty>This build registers no feature flags.</SettingsEmpty>
      ) : (
        <ul className="-mx-1 divide-y">
          {flags.map((flag) => {
            const inputId = `flag-${flag.key}`;
            const lockout = flag.key === "ff-core-program";
            return (
              <li className="flex items-start gap-3 px-1 py-3 first:pt-0 last:pb-0" key={flag.key}>
                <Checkbox
                  // The key and the description are *described by*, not the name: the visible
                  // label is now the readable one, and a screen-reader user should still hear the
                  // string they would type into `bun run flag enable`.
                  aria-describedby={`${inputId}-key ${inputId}-description`}
                  checked={flag.enabled}
                  className="mt-0.5"
                  id={inputId}
                  onCheckedChange={(checked) => toggle(flag, checked === true)}
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <Label className="font-medium text-sm" htmlFor={inputId}>
                    {flagLabel(flag.key)}
                  </Label>
                  <p
                    className="text-muted-foreground text-xs leading-relaxed"
                    id={`${inputId}-description`}
                  >
                    {flag.description}
                  </p>
                  {/*
                    The key, kept but demoted. It is the argument to `bun run flag enable`, so it
                    has to be readable — but it was the visible <Label>, which made the switch that
                    locks you out of the product look exactly like the one that adds a widget.
                  */}
                  <p className="font-mono text-2xs text-muted-foreground/70" id={`${inputId}-key`}>
                    {flag.key}
                  </p>
                </div>
                {lockout ? (
                  <span className="shrink-0 pt-0.5">
                    <SectionStatus tone="waiting">Kill switch</SectionStatus>
                  </span>
                ) : null}
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
      <ConfirmDialog
        confirmLabel="Turn off"
        description="This locks out Issue → run harness → review → approve for everyone in this Workspace — including most of the rest of this Settings page — until it is turned back on. There is no in-app undo: recovery is `bun run flag enable ff-core-program` on the machine running this instance."
        onConfirm={() => {
          if (pendingLockout) set.mutate({ key: pendingLockout.key, enabled: false });
          setPendingLockout(null);
        }}
        onOpenChange={(open) => {
          if (!open) setPendingLockout(null);
        }}
        open={pendingLockout !== null}
        title="Turn off the core Task loop?"
      />
    </SettingsSection>
  );
}
