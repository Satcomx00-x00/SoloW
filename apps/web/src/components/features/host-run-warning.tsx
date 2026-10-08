import {
  type ExecutorKind,
  type HarnessPermissionMode,
  HOST_RUN_WARNING,
  HOST_RUN_WARNING_TITLE,
  runsUnattendedOnHost,
} from "@solow/contracts";
import { ShieldAlert } from "lucide-react";

/**
 * The warning in front of the one pairing that is not isolated: a harness that never asks, run on
 * the orchestrator's own machine (roadmap B4). It renders nothing for any other pairing, so a
 * form can mount it unconditionally and the warning appears exactly when the choice is made.
 *
 * `role="alert"` because it appears as a consequence of a selection the Owner just made, and a
 * screen-reader user has to hear it as the selection lands rather than find it later.
 */
export function HostRunWarning({
  executorKind,
  permissionMode,
}: {
  executorKind: ExecutorKind | null | undefined;
  permissionMode: HarnessPermissionMode | null | undefined;
}) {
  if (!runsUnattendedOnHost(executorKind, permissionMode)) return null;
  return (
    <div
      className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm"
      role="alert"
    >
      <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="space-y-0.5">
        <p className="font-medium">{HOST_RUN_WARNING_TITLE}</p>
        <p className="text-muted-foreground text-xs leading-relaxed">{HOST_RUN_WARNING}</p>
      </div>
    </div>
  );
}
