"use client";

import type { SetupStepDto, SetupStepKey, WorkspaceSetupDto } from "@solow/contracts";
import { Power } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StepMarker } from "@/components/ui/steps";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { ConnectClaudeStep, RepositoryStep, TestStep } from "./setup-steps";

/**
 * The guided setup (roadmap E1, spec F18): connect Claude, choose a repository, try it.
 *
 * It replaced a seven-row checklist that sent a newcomer to six Settings screens in operator
 * vocabulary — a credential, a Harness Profile, an Executor — and proved nothing at the end. This
 * asks for the one thing it cannot work out (how you pay for Claude, and the token or key), makes
 * everything else in one step, and finishes with a real prompt.
 *
 * What it kept from the checklist is the principle that made that one honest: derived, never
 * dismissed. Every row here is read from the Workspace on each load (`workspace.setup`), so
 * leaving halfway loses nothing, and the setup comes back by itself if something it counted is
 * deleted. Non-blocking, too: the app stays usable underneath.
 *
 * Two places show it. On the projects page (`first-run`) it appears until the Workspace is ready
 * and then gets out of the way; at `/setup` (`rerun`, linked from Settings) it is always there,
 * so any step can be done again (FR-6).
 */

const STEP_TEXT: Record<SetupStepKey, { title: string; blurb: string }> = {
  claude: { title: "Connect Claude", blurb: "Use your Claude subscription or an API key." },
  repository: { title: "Choose a repository", blurb: "The code Claude will work on." },
  test: { title: "Try it", blurb: "A one-word reply from Claude proves it all works." },
};

/** One step: its marker, its name, what it has, and — when open — its panel. */
function StepRow({
  index,
  step,
  open,
  locked,
  last,
  onToggle,
  children,
}: {
  index: number;
  step: SetupStepDto;
  open: boolean;
  /** Nothing can be saved (the core loop is off), so no panel opens. */
  locked: boolean;
  last: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const text = STEP_TEXT[step.key];
  const panelId = `setup-step-${step.key}`;
  return (
    <li className={cn("py-4", !last && "border-b")}>
      <div className="flex items-start gap-3">
        <StepMarker className="mt-px" index={index} status={step.done ? "done" : "upcoming"} />
        <div className="min-w-0 flex-1">
          <h3 className={cn("text-sm", open ? "font-semibold" : "font-medium")}>
            {text.title}
            {step.done && <span className="sr-only"> — done</span>}
          </h3>
          {!open && (
            <p className="mt-0.5 truncate text-muted-foreground text-xs">
              {step.done && step.detail ? step.detail : text.blurb}
            </p>
          )}
        </div>
        {!open && !locked && (
          <Button
            aria-controls={panelId}
            aria-expanded={false}
            onClick={onToggle}
            size="sm"
            type="button"
            variant={step.done ? "ghost" : "outline"}
          >
            {step.done ? "Change" : "Start"}
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-4 sm:pl-8" id={panelId}>
          {children}
        </div>
      )}
    </li>
  );
}

/** The kill switch, said plainly and offered as the one click that fixes it. */
function CoreLoopOff() {
  const utils = trpc.useUtils();
  const setFlag = trpc.flag.set.useMutation({
    onSuccess: () => {
      void utils.workspace.setup.invalidate();
      void utils.flag.list.invalidate();
    },
  });
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-state-review/40 bg-state-review/5 px-3.5 py-2.5"
      role="alert"
    >
      <Power aria-hidden className="size-4 shrink-0 text-state-review" />
      <p className="min-w-0 flex-1 text-sm">
        Running agents is switched off for this workspace, so none of this can be saved until it is
        back on.
      </p>
      <Button
        loading={setFlag.isPending}
        onClick={() => setFlag.mutate({ key: "ff-core-program", enabled: true })}
        size="sm"
        type="button"
        variant="outline"
      >
        Turn it back on
      </Button>
    </div>
  );
}

function Finished({ onClose }: { onClose: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">You're set up</CardTitle>
        <CardDescription>
          Claude is connected, your code is ready and the test passed. Next, create a project to
          give Claude its first task.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={onClose} size="sm" type="button" variant="outline">
          Done
        </Button>
      </CardContent>
    </Card>
  );
}

export function GuidedSetup({ mode = "first-run" }: { mode?: "first-run" | "rerun" }) {
  const setup = trpc.workspace.setup.useQuery();
  /** The step the Owner opened; null follows the first one still to do. */
  const [chosen, setChosen] = useState<SetupStepKey | null>(null);
  /** Set when the last step passes in this sitting, so the ending is seen rather than vanishing. */
  const [finished, setFinished] = useState(false);

  // Silent while unknown: a setup that flashed "0 of 3" on every load would describe a fresh
  // install to someone whose Workspace is fully configured.
  if (!setup.data) return null;
  const data: WorkspaceSetupDto = setup.data;

  if (mode === "first-run" && data.ready) {
    return finished ? <Finished onClose={() => setFinished(false)} /> : null;
  }

  const done = data.steps.filter((s) => s.done).length;
  const following = data.ready ? null : (data.steps.find((s) => !s.done)?.key ?? null);
  const open = data.coreLoop ? (chosen ?? following) : null;
  // After a step completes, follow the next one still to do rather than staying on this one.
  const next = () => setChosen(null);

  const panel = (key: SetupStepKey) => {
    switch (key) {
      case "claude":
        return <ConnectClaudeStep onConnected={next} setup={data} />;
      case "repository":
        return <RepositoryStep onConnected={next} setup={data} />;
      case "test":
        return (
          <TestStep
            onGoTo={setChosen}
            onPassed={() => {
              next();
              setFinished(true);
            }}
            setup={data}
          />
        );
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle as="h2">{mode === "rerun" ? "Setup" : "Get started"}</CardTitle>
          <span className="text-muted-foreground text-xs tabular-nums">
            {done} of {data.steps.length} done
          </span>
        </div>
        <CardDescription>
          {mode === "rerun"
            ? "Change how Claude is connected, add a repository, or run the test again."
            : "Connect Claude, choose a repository and try it — a few minutes. You can leave and come back; nothing is lost."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {!data.coreLoop && <CoreLoopOff />}
        <ol aria-label="Setup steps">
          {data.steps.map((step, index) => (
            <StepRow
              index={index}
              key={step.key}
              last={index === data.steps.length - 1}
              locked={!data.coreLoop}
              onToggle={() => setChosen(step.key)}
              open={open === step.key}
              step={step}
            >
              {panel(step.key)}
            </StepRow>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
