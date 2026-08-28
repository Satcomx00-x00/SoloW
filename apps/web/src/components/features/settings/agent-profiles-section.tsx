"use client";

import type {
  AgentPermissionMode,
  AgentProbeReport,
  AgentProfileDto,
  AgentProtocol,
  AuthMode,
} from "@solow/contracts";
import {
  AGENT_PROTOCOL_PINS,
  AGENT_PROTOCOLS,
  agentProtocolSchema,
  DEFAULT_AGENT_PERMISSION_MODE,
} from "@solow/contracts";
import { ChevronRight, Stethoscope, Trash2 } from "lucide-react";
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
import { WHOLE_PAGE } from "@/lib/paged";
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
const PROTOCOL_HINT: Record<AgentProtocol, string> = Object.fromEntries(
  Object.entries(AGENT_PROTOCOLS).map(([protocol, d]) => [protocol, d.hint]),
) as Record<AgentProtocol, string>;

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
 * inside its worktree. The reason it exists at all is that SoloW runs agents headless —
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
      "The agent runs commands and fetches URLs without asking. It stays inside the worktree SoloW gave it, and every change still stops at the review gate before it reaches a branch — but within that worktree it has your shell.",
  },
];

/**
 * Create Agent Profiles: which agent (issue #10), auth mode + concurrency cap, permission mode,
 * bound to a stored Secret.
 */
/**
 * A probe report in one line, because it sits in a badge beside the Profile.
 *
 * A green result still says what it learned: an agent offering its own sign-in (opencode answers
 * `opencode-login`) has *worked* — the handshake completed — but an Owner reading only "works"
 * would not know a separate login is what stands between this and a real run.
 */
function probeSummary(report: AgentProbeReport): string {
  if (!report.ok) return report.reason ?? "did not respond";
  const { models, modes } = report.capabilities;
  const parts: string[] = [];
  if (models.length > 0) parts.push(`${models.length} models`);
  if (modes.length > 0) parts.push(`${modes.length} modes`);
  if (report.authMethods.length > 0) parts.push(`sign-in: ${report.authMethods.join(", ")}`);
  return parts.length > 0 ? `works · ${parts.join(" · ")}` : "works";
}

/**
 * The pinned model or mode this agent's last handshake no longer lists, or null.
 *
 * Null when the cache is empty — an agent that has never run has advertised nothing, and
 * "unknown" must not read as "retired".
 */
function stalePinOn(
  profile: { agentCatalogId: string; model: string | null; modeId: string | null },
  catalog: readonly { id: string; capabilities: { models: string[]; modes: string[] } }[],
): string | null {
  const advertised = catalog.find((c) => c.id === profile.agentCatalogId)?.capabilities;
  if (!advertised) return null;
  if (profile.model && advertised.models.length > 0 && !advertised.models.includes(profile.model)) {
    return profile.model;
  }
  if (profile.modeId && advertised.modes.length > 0 && !advertised.modes.includes(profile.modeId)) {
    return profile.modeId;
  }
  return null;
}

export function AgentProfilesSection() {
  const utils = trpc.useUtils();
  const profiles = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE });
  const catalog = trpc.profile.agentCatalog.list.useQuery({});
  const secrets = trpc.secret.list.useQuery({});
  const [name, setName] = useState("");
  const [agentCatalogId, setAgentCatalogId] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("subscription");
  const [secretId, setSecretId] = useState("");
  const [cap, setCap] = useState(3);
  /**
   * The model and mode this Profile launches with (issue #94).
   *
   * Free text, not a picker, and that is the honest shape today: the list an agent advertises
   * comes from its handshake, which happens when a run starts — there is nothing to populate a
   * dropdown with before a Profile has ever been used. A `Select` over a hardcoded list would be
   * the guaranteed-to-rot menu the issue rules out in as many words, offering choices that fail
   * at launch. Empty means "whatever the agent chooses", which is what every Profile did before
   * this existed.
   */
  const [model, setModel] = useState("");
  const [modeId, setModeId] = useState("");
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(
    DEFAULT_AGENT_PERMISSION_MODE,
  );

  const catalogOptions = catalog.data ?? [];
  /**
   * What the chosen agent last advertised (issue #94 AC-2) — the suggestions under the two pin
   * fields. Empty until that agent has run once: the cache is written from the handshake, and
   * before a first run there is honestly nothing to suggest.
   */
  const advertised = catalogOptions.find((c) => c.id === agentCatalogId)?.capabilities ?? {
    models: [],
    modes: [],
  };
  /**
   * Which pins the chosen agent's protocol can actually be told — read from the contracts, the
   * same rule the runner reports against, so this form cannot accept a setting the run will
   * ignore (see `AGENT_PROTOCOL_PINS`). Defaults to allowing both until an agent is chosen,
   * because disabling a field before there is a protocol to justify it explains nothing.
   */
  const chosenProtocol = catalogOptions.find((c) => c.id === agentCatalogId)?.protocol;
  const pins = chosenProtocol ? AGENT_PROTOCOL_PINS[chosenProtocol] : { model: true, mode: true };

  // Preselect once the list loads. A Workspace now ships with two entries (Claude Code and
  // opencode), so this picks the first rather than "the only one" — the Owner still chooses, and
  // the protocol line under the picker is what tells them the two differ.
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

  /**
   * "Does this actually work?", asked before a Task depends on the answer.
   *
   * Nothing verified a Profile until a run failed on it — a misspelled command, an agent that
   * was never installed, a Secret pointing at a revoked key all looked identical to a working
   * Profile until a Task was queued, worktreed, briefed and then lost. The catalog list is
   * invalidated on success because a successful probe also fills the capability cache the pin
   * pickers read, so the model and mode lists can go from empty to populated without a run.
   */
  const [probed, setProbed] = useState<Record<string, AgentProbeReport>>({});
  const probeProfile = trpc.profile.agent.probe.useMutation({
    onSuccess: (report, variables) => {
      setProbed((prev) => ({ ...prev, [variables.agentProfileId]: report }));
      utils.profile.agentCatalog.list.invalidate();
    },
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
              // Trimmed to null rather than sent as "": an empty pin is the absence of one, and
              // storing a blank string would make "no model" and "a model named nothing" the
              // same row.
              //
              // Dropped entirely when the chosen protocol cannot be told it: the field is
              // disabled, but a value typed against one agent and then left behind by switching
              // to another would still be in state, and storing it would put a pin on the
              // Profile that every run reports it could not honour.
              model: pins.model && model.trim() !== "" ? model.trim() : null,
              modeId: pins.mode && modeId.trim() !== "" ? modeId.trim() : null,
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
            {/*
              The protocol, said where the choice is made rather than only where a catalog entry
              is created. With more than one agent seeded it stops being a constant: Claude Code
              and opencode differ on whether they can be asked for permission mid-run, and on
              which of the two pins below does anything — and neither is visible from a name.
            */}
            {chosenProtocol && (
              <p className="text-muted-foreground text-xs leading-relaxed">
                {PROTOCOL_HINT[chosenProtocol]}
              </p>
            )}
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
          <div className="grid grid-cols-2 gap-3">
            {/*
              `datalist`, not `Select` — the shape the data honestly has. The suggestions are a
              cache of what this agent advertised at its last handshake: present after a first
              run, empty before one, and never guaranteed complete. A dropdown would claim the
              list is closed and offer nothing at all on a fresh install; a datalist suggests
              what is known and still accepts what is not, which is exactly the contract.
            */}
            <div className="grid gap-2">
              <Label htmlFor="agent-model">Model</Label>
              <Input
                id="agent-model"
                list="agent-model-options"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={!pins.model}
                placeholder={
                  pins.model ? "the agent's own choice" : "this agent's protocol cannot be told"
                }
              />
              <datalist id="agent-model-options">
                {advertised.models.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-mode">Mode</Label>
              <Input
                id="agent-mode"
                list="agent-mode-options"
                value={modeId}
                onChange={(event) => setModeId(event.target.value)}
                disabled={!pins.mode}
                placeholder={
                  pins.mode ? "the agent's own default" : "this agent's protocol cannot be told"
                }
              />
              <datalist id="agent-mode-options">
                {advertised.modes.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </div>
          </div>
          {/*
            Said once, under both: which of the two an agent can actually be told is a property
            of its protocol, and a Profile that pins the one its protocol cannot select would
            otherwise look like it had taken effect.
          */}
          <p className="text-muted-foreground text-xs leading-relaxed">
            Left empty, the agent chooses. A pin the agent's protocol cannot select is reported in
            the run's log rather than silently ignored.
          </p>
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
                  {/*
                    Derived from the enum, not listed by hand: this was the one place adding a
                    protocol broke silently in JSX, where no compiler was ever going to say so.
                  */}
                  <SelectContent>
                    {agentProtocolSchema.options.map((protocol) => (
                      <SelectItem key={protocol} value={protocol}>
                        {AGENT_PROTOCOLS[protocol].label}
                      </SelectItem>
                    ))}
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

        {(profiles.data?.items.length ?? 0) > 0 && (
          <ul className="divide-y border-t">
            {(profiles.data?.items ?? []).map((p) => {
              const inUse = describeAgentProfileUsage(p.usage);
              return (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">
                        {p.name} · {p.authMode} · cap {p.concurrencyCap}
                      </Badge>
                      {/* A pin is worth showing because it is the exception: most Profiles let
                          the agent choose, and a row that names a model is one whose runs will
                          differ from its neighbours'. */}
                      {(p.model || p.modeId) && (
                        <Badge variant="outline" className="font-mono text-2xs">
                          {[p.model, p.modeId].filter(Boolean).join(" · ")}
                        </Badge>
                      )}
                      {/*
                        A pin the agent no longer advertises (issue #94 AC-3).

                        Judged against the cache only when the cache says anything: an agent that
                        has never run has an empty cache, and warning about every pin on a fresh
                        install would train people to ignore the one warning that matters. The
                        run itself never substitutes — this is the surface that lets somebody
                        fix the pin *before* the launch that would have to say so.
                      */}
                      {stalePinOn(p, catalogOptions) && (
                        <Badge
                          variant="outline"
                          className="border-state-failed/40 text-2xs text-state-failed"
                          title="This agent's last handshake did not advertise it. The run will say so and use the agent's own choice — edit the pin here to fix it."
                        >
                          {stalePinOn(p, catalogOptions)} no longer advertised
                        </Badge>
                      )}
                      {/*
                        What the last probe found, kept beside the Profile it is about rather
                        than in a toast that outlives its context. A failure carries its reason
                        in the badge itself: "it did not work" without the why would send an
                        Owner back to guessing, which is the state this replaced.
                      */}
                      {probed[p.id] && (
                        <Badge
                          variant="outline"
                          className={
                            probed[p.id]?.ok
                              ? "border-state-ready/40 text-2xs text-state-ready"
                              : "border-state-failed/40 text-2xs text-state-failed"
                          }
                          title={probeSummary(probed[p.id] as AgentProbeReport)}
                        >
                          {probeSummary(probed[p.id] as AgentProbeReport)}
                        </Badge>
                      )}
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
                    Deliberately never disabled — a Profile that is in use is the one it is most
                    urgent to be able to test, and "in use" is not evidence that it still works.
                  */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Test the agent profile ${p.name}`}
                    loading={
                      probeProfile.isPending && probeProfile.variables?.agentProfileId === p.id
                    }
                    onClick={() => probeProfile.mutate({ agentProfileId: p.id })}
                  >
                    <Stethoscope />
                  </Button>
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
