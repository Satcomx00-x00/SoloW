"use client";

import type { SetupStepDto } from "@solow/contracts";
import { Check, Pencil } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/trpc/react";

/**
 * What this Workspace still needs, and the way to each of it (2026-08-28).
 *
 * It replaced a fixture. A local install used to arrive holding two invented companies, each
 * with a credential, an Agent Profile, an Executor and a repository that never existed — so the
 * product looked configured on first launch and the real gap stayed hidden: a Workspace from a
 * genuine sign-up has none of those, and its feature flags are off, so the core loop is
 * disabled. Nothing said so; you found out when a Task refused to run.
 *
 * Derived, never dismissed. The state comes from the rows that exist on every read, so this is
 * a standing view of the Workspace rather than a one-time ceremony — it comes back if the Secret
 * it was counting gets deleted, which is precisely when it should. It disappears on its own once
 * everything is done, so there is no "finish setup" button to press and nothing to remember.
 *
 * Non-blocking on purpose: the app stays usable underneath. Somebody who wants to look around
 * before connecting a credential should be able to.
 */

/** Step id → how it reads, and where its action goes. */
const STEPS: Record<
  SetupStepDto["key"],
  { title: string; blurb: string; href?: string; action?: string }
> = {
  workspace: {
    title: "Workspace",
    blurb: "Everything you create belongs to it.",
  },
  agents: {
    title: "Agents available",
    blurb: "The agents this install can run.",
    href: "/settings?section=agent-profiles",
    action: "View",
  },
  secret: {
    title: "Credential",
    blurb: "What authenticates the agent. Stored encrypted; only ever referenced by name.",
    href: "/settings?section=secrets",
    action: "Add a secret",
  },
  "agent-profile": {
    title: "Agent profile",
    blurb: "Binds an agent to a credential, with its permission mode and concurrency cap.",
    href: "/settings?section=agent-profiles",
    action: "Create a profile",
  },
  executor: {
    title: "Executor",
    blurb: "Where agents actually run — this machine, or a container.",
    href: "/settings?section=executor-profiles",
    action: "Create an executor",
  },
  repository: {
    title: "Repository",
    blurb: "Connect a provider and import one; its issues come with it.",
    href: "/settings?section=integrations",
    action: "Connect a provider",
  },
  "core-loop": {
    title: "Main loop",
    blurb: "Running Tasks is behind a feature flag, and it ships off.",
  },
};

/** What a step is waiting on, named rather than left as a dead button. */
const BLOCKED_BY: Record<string, string> = {
  secret: "Needs a credential first",
};

function StepRow({ step }: { step: SetupStepDto }) {
  const meta = STEPS[step.key];
  const utils = trpc.useUtils();

  // The deadlock-breaker, offered inline rather than as a link into the flags table: the core
  // loop is the one step whose "action" is a single boolean, and sending someone to a different
  // screen to flip it is how a checklist becomes a list of errands.
  const setFlag = trpc.flag.set.useMutation({
    onSuccess: () => {
      utils.workspace.setup.invalidate();
      utils.flag.list.invalidate();
    },
  });

  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        aria-hidden
        className={
          step.done
            ? "mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full bg-state-ready/15 text-state-ready"
            : "mt-0.5 size-4.5 shrink-0 rounded-full border border-muted-foreground/30"
        }
      >
        {step.done && <Check className="size-3" strokeWidth={3} />}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-sm">{meta.title}</span>
          {step.detail && (
            <span className="truncate text-muted-foreground text-xs">{step.detail}</span>
          )}
        </div>
        {!step.done && (
          <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">{meta.blurb}</p>
        )}
      </div>

      {!step.done && (
        <div className="shrink-0">
          {step.blockedBy ? (
            <span className="text-muted-foreground/70 text-xs">
              {BLOCKED_BY[step.blockedBy] ?? `Needs ${step.blockedBy}`}
            </span>
          ) : step.key === "core-loop" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={setFlag.isPending}
              onClick={() => setFlag.mutate({ key: "ff-core-program", enabled: true })}
            >
              Turn it on
            </Button>
          ) : meta.href ? (
            <Button asChild size="sm" variant="outline">
              <Link href={meta.href}>{meta.action}</Link>
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** Rename, in place. The name is the one part of a Workspace an Owner ever needs to change. */
function WorkspaceName({ name }: { name: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const utils = trpc.useUtils();
  const rename = trpc.workspace.rename.useMutation({
    onSuccess: () => {
      setEditing(false);
      utils.workspace.setup.invalidate();
      utils.workspace.get.invalidate();
      // The shell renders the name from a server component, so the crumb is stale until the
      // route re-renders. Refreshing here is what stops the header disagreeing with this card.
      window.location.reload();
    },
  });

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
        className="group inline-flex items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground"
        aria-label={`Rename the workspace ${name}`}
      >
        <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
        Rename
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const next = draft.trim();
        if (next && next !== name) rename.mutate({ name: next });
        else setEditing(false);
      }}
    >
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Workspace name"
        className="h-7 w-52 text-sm"
      />
      <Button type="submit" size="sm" loading={rename.isPending}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}

export function WorkspaceSetupCard() {
  const setup = trpc.workspace.setup.useQuery();

  // Silent while unknown and silent when finished: a card that flashed "0/7" on every load, or
  // sat at "7/7 done" forever, would be furniture rather than information.
  if (!setup.data || setup.data.ready) return null;

  const { steps, workspace } = setup.data;
  const done = steps.filter((s) => s.done).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Set this workspace up</CardTitle>
          <span className="text-muted-foreground text-xs tabular-nums">
            {done}/{steps.length}
          </span>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <span>{workspace.name}</span>
          <WorkspaceName name={workspace.name} />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {steps.map((step) => (
            <StepRow key={step.key} step={step} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
