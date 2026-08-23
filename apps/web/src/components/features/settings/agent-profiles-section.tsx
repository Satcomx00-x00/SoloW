"use client";

import type {
  AgentPermissionMode,
  AgentProfileDto,
  AgentProtocol,
  AuthMode,
} from "@gatecontrol/contracts";
import { DEFAULT_AGENT_PERMISSION_MODE } from "@gatecontrol/contracts";
import { ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * What each protocol actually means, spelled out where the Owner is about to pick one — the
 * enum's own values (`claude_code_stream_json`, `acp`, `cli_passthrough`) say nothing about the
 * consequence of choosing wrong. `acp` is the one that matters here: it is the only protocol
 * with a working permission channel (`acp-runner.ts` implements the full
 * `session/request_permission` round trip), so it is the one to pick for an agent that should
 * ever ask before doing something rather than deciding on its own.
 */
const PROTOCOL_HINT: Record<AgentProtocol, string> = {
  claude_code_stream_json:
    "Claude Code's own headless CLI. No permission channel — the CLI decides for itself.",
  acp: "Agent Client Protocol. Can ask for permission mid-run — this is what the inline elicitation card needs.",
  cli_passthrough: "A plain CLI driven by arguments and stdout. No permission channel.",
};

/**
 * How a Profile's usage reads in the confirmation and the disabled-button title. Named parts
 * rather than a bare total: "3 tasks, 1 workflow step" tells the Owner what to go move or
 * finish, "4 things" does not — same reasoning as `secrets-section.tsx`'s `describeUsage`.
 */
function describeAgentProfileUsage(usage: AgentProfileDto["usage"]): string {
  const parts: string[] = [];
  if (usage.taskCount > 0) parts.push(`${usage.taskCount} task${usage.taskCount === 1 ? "" : "s"}`);
  if (usage.workflowStepCount > 0) {
    parts.push(
      `${usage.workflowStepCount} workflow step${usage.workflowStepCount === 1 ? "" : "s"}`,
    );
  }
  if (usage.sessionUsageCount > 0) {
    // Session usage is billing history, not something still "in flight" — worded to say so,
    // since a fresh Owner reading "3 sessions" would otherwise expect 3 live runs.
    parts.push(
      `${usage.sessionUsageCount} past session${usage.sessionUsageCount === 1 ? "" : "s"}`,
    );
  }
  return parts.join(", ");
}

/**
 * What each permission mode means, in the operator's terms rather than the CLI's.
 *
 * `bypassPermissions` is described by what it grants, not by how safe it sounds, because that is
 * the choice being made: an agent that never asks is an agent with the shell and the network
 * inside its worktree. The reason it exists at all is that GateControl runs agents headless —
 * under the default mode there is nobody for a prompt to reach, so a Task needing either simply
 * fails partway through, which is a worse outcome badly disguised as a safer one.
 */
const PERMISSION_MODES: Array<{
  value: AgentPermissionMode;
  label: string;
  description: string;
}> = [
  {
    value: "acceptEdits",
    label: "Edit files, ask for the rest (default)",
    description:
      "The agent changes files in its own worktree freely. Anything else — running a command, fetching a URL — needs approval, and a headless run has nobody to approve it, so tasks that need the shell or the network will stall.",
  },
  {
    value: "plan",
    label: "Read only, change nothing",
    description:
      "The agent may read and reason but not edit, run or fetch. Useful for a profile that reviews or proposes rather than does.",
  },
  {
    value: "bypassPermissions",
    label: "Never ask",
    description:
      "The agent runs commands and fetches URLs without asking. It stays inside the worktree GateControl gave it, and every change still stops at the review gate before it reaches a branch — but within that worktree it has your shell.",
  },
];

/**
 * Create Agent Profiles: which agent (issue #10), auth mode + concurrency cap, permission mode,
 * bound to a stored Secret.
 */
export function AgentProfilesSection() {
  const utils = trpc.useUtils();
  const profiles = trpc.profile.agent.list.useQuery({});
  const catalog = trpc.profile.agentCatalog.list.useQuery({});
  const secrets = trpc.secret.list.useQuery({});
  const [name, setName] = useState("");
  const [agentCatalogId, setAgentCatalogId] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("subscription");
  const [secretId, setSecretId] = useState("");
  const [cap, setCap] = useState(3);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(
    DEFAULT_AGENT_PERMISSION_MODE,
  );

  const catalogOptions = catalog.data ?? [];
  // A Workspace ships with exactly one catalog entry today (Claude Code) — pick it once it
  // loads, so a self-hoster with more than one configured still sees an explicit choice.
  useEffect(() => {
    if (!agentCatalogId && catalogOptions[0]) setAgentCatalogId(catalogOptions[0].id);
  }, [agentCatalogId, catalogOptions]);

  const create = trpc.profile.agent.create.useMutation({
    onSuccess: () => {
      utils.profile.agent.list.invalidate();
      setName("");
      setSecretId("");
    },
  });

  // A second catalog row, most of the time, means naming an ACP-speaking binary (a native ACP
  // agent, or a bridge like claude-agent-acp) so a Profile can finally point at the protocol
  // that has a real permission channel. Kept as its own form rather than folded into the one
  // above: creating a catalog entry and creating a Profile that uses it are different acts —
  // one names an agent this Workspace CAN run, the other decides that THIS Workspace runs it,
  // with which credential and what concurrency.
  const [catalogKey, setCatalogKey] = useState("");
  const [catalogDisplayName, setCatalogDisplayName] = useState("");
  const [catalogProtocol, setCatalogProtocol] = useState<AgentProtocol>("acp");
  const [catalogCommand, setCatalogCommand] = useState("");
  const [catalogSubscriptionEnvVar, setCatalogSubscriptionEnvVar] = useState("");
  const [catalogMeteredEnvVar, setCatalogMeteredEnvVar] = useState("");

  const createCatalogEntry = trpc.profile.agentCatalog.create.useMutation({
    onSuccess: () => {
      utils.profile.agentCatalog.list.invalidate();
      setCatalogKey("");
      setCatalogDisplayName("");
      setCatalogCommand("");
      setCatalogSubscriptionEnvVar("");
      setCatalogMeteredEnvVar("");
    },
  });

  const deleteProfile = trpc.profile.agent.delete.useMutation({
    onSuccess: () => utils.profile.agent.list.invalidate(),
  });

  // Editable in place rather than through a form: the reason an Owner comes to this page is
  // almost always that a run stalled on a permission nobody could answer, and making them
  // delete a Profile (orphaning its history) to change one setting is not an answer.
  const updateProfile = trpc.profile.agent.update.useMutation({
    onSuccess: () => utils.profile.agent.list.invalidate(),
  });

  const secretOptions = secrets.data ?? [];

  return (
    <Card id="agent-profiles" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Agent profiles</CardTitle>
        <CardDescription>Auth mode + concurrency cap, bound to a stored secret.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              name,
              agentCatalogId,
              authMode,
              secretId,
              concurrencyCap: cap,
              permissionMode,
            });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              placeholder="e.g. Claude Code"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-catalog">Agent</Label>
            <Select value={agentCatalogId} onValueChange={setAgentCatalogId}>
              <SelectTrigger className="w-full" id="agent-catalog">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {catalogOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="agent-authmode">Auth mode</Label>
              <Select value={authMode} onValueChange={(v) => setAuthMode(v as AuthMode)}>
                <SelectTrigger id="agent-authmode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="api_key">API key</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-cap">Concurrency cap</Label>
              <Input
                id="agent-cap"
                type="number"
                min={1}
                max={20}
                value={cap}
                onChange={(e) => setCap(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-secret">Secret</Label>
            <Select value={secretId} onValueChange={setSecretId}>
              <SelectTrigger id="agent-secret" className="w-full">
                <SelectValue placeholder="Select a secret" />
              </SelectTrigger>
              <SelectContent>
                {secretOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} ({s.kind})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {secretOptions.length === 0 && (
              <p className="text-muted-foreground text-xs">
                Add a secret first to create a profile.
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-permission">Permission mode</Label>
            <Select
              value={permissionMode}
              onValueChange={(v) => setPermissionMode(v as AgentPermissionMode)}
            >
              <SelectTrigger id="agent-permission" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/*
              The explanation is per-mode rather than one paragraph covering all three: what
              matters is what *this* choice costs, and a reader picking "Never ask" needs the
              sentence about the shell and the network in front of them, not three lines up.
            */}
            <p className="text-muted-foreground text-xs leading-relaxed">
              {PERMISSION_MODES.find((m) => m.value === permissionMode)?.description}
            </p>
          </div>
          <Button
            type="submit"
            loading={create.isPending}
            disabled={secretOptions.length === 0 || !secretId || !agentCatalogId}
          >
            Add profile
          </Button>
        </form>
        {create.error && (
          <p className="text-destructive text-sm" role="alert">
            {create.error.message}
          </p>
        )}

        {/*
          Collapsed by default, same reasoning as the tool-call rows in the task terminal: most
          Owners only ever use the seeded Claude Code entry, and an always-open second form
          would out-weigh the one form people actually need on every visit to this page.
        */}
        <details className="group rounded-lg border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
            />
            <span className="font-medium">Add a custom agent</span>
            <span className="text-2xs text-muted-foreground">
              Name a new protocol/command an Agent Profile can point at
            </span>
          </summary>

          <div className="space-y-4 border-t px-3 pt-3 pb-4">
            {catalogOptions.length > 0 && (
              <ul className="space-y-1">
                {catalogOptions.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-xs">
                    <Badge variant="outline" className="shrink-0 font-mono">
                      {c.key}
                    </Badge>
                    <span className="truncate text-muted-foreground">
                      {c.displayName} · {c.protocol}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                createCatalogEntry.mutate({
                  key: catalogKey,
                  displayName: catalogDisplayName,
                  protocol: catalogProtocol,
                  command: catalogCommand,
                  argsTemplate: [],
                  installHint: null,
                  subscriptionEnvVar: catalogSubscriptionEnvVar,
                  meteredEnvVar: catalogMeteredEnvVar,
                });
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="catalog-key">Key</Label>
                  <Input
                    id="catalog-key"
                    placeholder="e.g. claude_acp"
                    pattern="^[a-z][a-z0-9_]*$"
                    title="lowercase snake_case, e.g. claude_acp"
                    value={catalogKey}
                    onChange={(e) => setCatalogKey(e.target.value)}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="catalog-display-name">Display name</Label>
                  <Input
                    id="catalog-display-name"
                    placeholder="e.g. Claude Code (ACP)"
                    value={catalogDisplayName}
                    onChange={(e) => setCatalogDisplayName(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="catalog-protocol">Protocol</Label>
                <Select
                  value={catalogProtocol}
                  onValueChange={(v) => setCatalogProtocol(v as AgentProtocol)}
                >
                  <SelectTrigger id="catalog-protocol" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="acp">ACP</SelectItem>
                    <SelectItem value="claude_code_stream_json">
                      Claude Code (stream-json)
                    </SelectItem>
                    <SelectItem value="cli_passthrough">CLI passthrough</SelectItem>
                  </SelectContent>
                </Select>
                <p
                  className={cn(
                    "text-2xs",
                    catalogProtocol === "acp" ? "text-state-done" : "text-muted-foreground",
                  )}
                >
                  {PROTOCOL_HINT[catalogProtocol]}
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="catalog-command">Command</Label>
                <Input
                  id="catalog-command"
                  placeholder="e.g. claude-agent-acp"
                  value={catalogCommand}
                  onChange={(e) => setCatalogCommand(e.target.value)}
                  required
                />
                <p className="text-2xs text-muted-foreground">
                  Resolved on PATH when a Task using this agent launches — install it on the machine
                  running the orchestrator first.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="catalog-sub-var">Subscription credential variable</Label>
                  <Input
                    id="catalog-sub-var"
                    placeholder="e.g. CLAUDE_CODE_OAUTH_TOKEN"
                    pattern="^[A-Za-z_][A-Za-z0-9_]*$"
                    value={catalogSubscriptionEnvVar}
                    onChange={(e) => setCatalogSubscriptionEnvVar(e.target.value)}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="catalog-metered-var">Metered credential variable</Label>
                  <Input
                    id="catalog-metered-var"
                    placeholder="e.g. ANTHROPIC_API_KEY"
                    pattern="^[A-Za-z_][A-Za-z0-9_]*$"
                    value={catalogMeteredEnvVar}
                    onChange={(e) => setCatalogMeteredEnvVar(e.target.value)}
                    required
                  />
                </div>
              </div>
              <p className="text-2xs text-muted-foreground">
                Whichever of these two an Agent Profile's auth mode does not use is stripped from
                the run's environment, never just left unset — a Subscription-mode run can never
                carry a metered credential (Principle IV).
              </p>

              <Button type="submit" size="sm" loading={createCatalogEntry.isPending}>
                Add to catalog
              </Button>
            </form>
            {createCatalogEntry.error && (
              <p className="text-destructive text-sm" role="alert">
                {createCatalogEntry.error.message}
              </p>
            )}
          </div>
        </details>

        {(profiles.data?.length ?? 0) > 0 && (
          <ul className="divide-y border-t">
            {(profiles.data ?? []).map((p) => {
              const inUse = describeAgentProfileUsage(p.usage);
              return (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">
                        {p.name} · {p.authMode} · cap {p.concurrencyCap}
                      </Badge>
                      {/* Badged for the *exception*, which is now the Profile that still asks:
                          marking every row with the ordinary case would say nothing at all, and
                          a Profile that stalls on a prompt nobody can answer is the one worth
                          spotting in a list. */}
                      {p.permissionMode !== DEFAULT_AGENT_PERMISSION_MODE && (
                        <Badge
                          variant="outline"
                          className="border-state-review/40 text-state-review"
                        >
                          {p.permissionMode === "plan" ? "read only" : "asks first"}
                        </Badge>
                      )}
                    </div>
                    {inUse && (
                      <p className="mt-1 truncate text-muted-foreground text-xs">Used by {inUse}</p>
                    )}
                  </div>
                  <Select
                    value={p.permissionMode}
                    onValueChange={(v) =>
                      updateProfile.mutate({ id: p.id, permissionMode: v as AgentPermissionMode })
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-44 shrink-0"
                      aria-label={`Permission mode for ${p.name}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERMISSION_MODES.map((mode) => (
                        <SelectItem key={mode.value} value={mode.value}>
                          {mode.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/*
                    A Profile in use is not deletable at all — the server refuses it, and a
                    button that only ever produces an error is worse than one that explains
                    itself. The reason sits beside it, so the disabled state is never a mystery
                    (same idiom as the Secrets list above).
                  */}
                  <ConfirmAction
                    title={`Delete "${p.name}"?`}
                    description="This cannot be undone. Deleting a Profile does not touch the Secret it spends — only the binding between them."
                    confirmLabel="Delete profile"
                    disabled={inUse.length > 0}
                    onConfirm={() => deleteProfile.mutate({ id: p.id })}
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={inUse.length > 0}
                        aria-label={`Delete the agent profile ${p.name}`}
                        loading={deleteProfile.isPending && deleteProfile.variables?.id === p.id}
                      >
                        <Trash2 />
                      </Button>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
        {deleteProfile.error && (
          <p className="text-destructive text-sm" role="alert">
            {deleteProfile.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
