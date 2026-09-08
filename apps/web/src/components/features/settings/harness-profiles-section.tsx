"use client";

import type {
  AuthMode,
  HarnessPermissionMode,
  HarnessProbeReport,
  HarnessProfileDto,
  HarnessProtocol,
} from "@solow/contracts";
import {
  DEFAULT_HARNESS_PERMISSION_MODE,
  HARNESS_PROTOCOL_PINS,
  HARNESS_PROTOCOLS,
  harnessProtocolSchema,
} from "@solow/contracts";
import { ChevronRight, ShieldAlert, Stethoscope, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmAction, ConfirmDialog } from "@/components/features/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  SectionStatus,
  SettingsCreate,
  SettingsEmpty,
  SettingsLoading,
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "./settings-shell";

/**
 * What each protocol actually means, spelled out where the Owner is about to pick one — the
 * enum's own values (`claude_code_stream_json`, `acp`, `cli_passthrough`) say nothing about the
 * consequence of choosing wrong. `acp` is the one that matters here: it is the only protocol
 * with a working permission channel (`acp-runner.ts` implements the full
 * `session/request_permission` round trip), so it is the one to pick for a harness that should
 * ever ask before doing something rather than deciding on its own.
 */
const PROTOCOL_HINT: Record<HarnessProtocol, string> = Object.fromEntries(
  Object.entries(HARNESS_PROTOCOLS).map(([protocol, d]) => [protocol, d.hint]),
) as Record<HarnessProtocol, string>;

/**
 * How a Profile's usage reads in the confirmation and the disabled-button title. Named parts
 * rather than a bare total: "3 tasks, 1 workflow step" tells the Owner what to go move or
 * finish, "4 things" does not — same reasoning as `secrets-section.tsx`'s `describeUsage`.
 */
function describeHarnessProfileUsage(usage: HarnessProfileDto["usage"]): string {
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
 * the choice being made: a harness that never asks is a harness with the shell and the network
 * inside its worktree. The reason it exists at all is that SoloW runs harnesses headless —
 * under the default mode there is nobody for a prompt to reach, so a Task needing either simply
 * fails partway through, which is a worse outcome badly disguised as a safer one.
 */
/**
 * How much each mode grants, so "is this change an increase" is one comparison rather than a
 * hand-written matrix that will disagree with itself the day a fourth mode arrives.
 */
const PERMISSION_RANK: Record<HarnessPermissionMode, number> = {
  plan: 0,
  acceptEdits: 1,
  bypassPermissions: 2,
};

/** What is being granted, in the words the field below already uses. */
const PERMISSION_ESCALATION_COPY: Record<HarnessPermissionMode, string> = {
  plan: "The harness may read and reason, but change nothing.",
  acceptEdits:
    "The harness may edit files inside its own worktree without asking. Anything beyond that still stops for a prompt — and because SoloW runs harnesses headless, a prompt reaches nobody, so a task needing the shell or the network will stall rather than proceed.",
  bypassPermissions:
    "The harness never asks. Within its worktree it has your shell and the network, on every future run of this profile. The bound on it is the worktree it is confined to and the review gate every change still stops at — not a question, because a headless run has nobody to answer one.",
};

const PERMISSION_MODES: Array<{
  value: HarnessPermissionMode;
  label: string;
  description: string;
}> = [
  {
    value: "acceptEdits",
    label: "Edit files, ask for the rest (default)",
    description:
      "The harness changes files in its own worktree freely. Anything else — running a command, fetching a URL — needs approval, and a headless run has nobody to approve it, so tasks that need the shell or the network will stall.",
  },
  {
    value: "plan",
    label: "Read only, change nothing",
    description:
      "The harness may read and reason but not edit, run or fetch. Useful for a profile that reviews or proposes rather than does.",
  },
  {
    value: "bypassPermissions",
    label: "Never ask",
    description:
      "The harness runs commands and fetches URLs without asking. It stays inside the worktree SoloW gave it, and every change still stops at the review gate before it reaches a branch — but within that worktree it has your shell.",
  },
];

/**
 * Create Harness Profiles: which harness (issue #10), auth mode + concurrency cap, permission mode,
 * bound to a stored Secret.
 */
/**
 * A probe report in one line, because it sits in a badge beside the Profile.
 *
 * A green result still says what it learned: a harness offering its own sign-in (opencode answers
 * `opencode-login`) has *worked* — the handshake completed — but an Owner reading only "works"
 * would not know a separate login is what stands between this and a real run.
 */
function probeSummary(report: HarnessProbeReport): string {
  if (!report.ok) return report.reason ?? "did not respond";
  const { models, modes } = report.capabilities;
  const parts: string[] = [];
  if (models.length > 0) parts.push(`${models.length} models`);
  if (modes.length > 0) parts.push(`${modes.length} modes`);
  if (report.authMethods.length > 0) parts.push(`sign-in: ${report.authMethods.join(", ")}`);
  return parts.length > 0 ? `works · ${parts.join(" · ")}` : "works";
}

/**
 * The pinned model or mode this harness's last handshake no longer lists, or null.
 *
 * Null when the cache is empty — a harness that has never run has advertised nothing, and
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

export function HarnessProfilesSection() {
  const utils = trpc.useUtils();
  const profiles = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE });
  const catalog = trpc.profile.agentCatalog.list.useQuery({});
  const secrets = trpc.secret.list.useQuery({});
  const [name, setName] = useState("");
  const [harnessCatalogId, setHarnessCatalogId] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("subscription");
  const [secretId, setSecretId] = useState("");
  const [cap, setCap] = useState(3);
  /**
   * The model and mode this Profile launches with (issue #94).
   *
   * Free text, not a picker, and that is the honest shape today: the list a harness advertises
   * comes from its handshake, which happens when a run starts — there is nothing to populate a
   * dropdown with before a Profile has ever been used. A `Select` over a hardcoded list would be
   * the guaranteed-to-rot menu the issue rules out in as many words, offering choices that fail
   * at launch. Empty means "whatever the harness chooses", which is what every Profile did before
   * this existed.
   */
  const [model, setModel] = useState("");
  const [modeId, setModeId] = useState("");
  const [permissionMode, setPermissionMode] = useState<HarnessPermissionMode>(
    DEFAULT_HARNESS_PERMISSION_MODE,
  );

  const catalogOptions = catalog.data ?? [];
  /**
   * What the chosen harness last advertised (issue #94 AC-2) — the suggestions under the two pin
   * fields. Empty until that harness has run once: the cache is written from the handshake, and
   * before a first run there is honestly nothing to suggest.
   */
  const advertised = catalogOptions.find((c) => c.id === harnessCatalogId)?.capabilities ?? {
    models: [],
    modes: [],
  };
  /**
   * Which pins the chosen harness's protocol can actually be told — read from the contracts, the
   * same rule the runner reports against, so this form cannot accept a setting the run will
   * ignore (see `HARNESS_PROTOCOL_PINS`). Defaults to allowing both until a harness is chosen,
   * because disabling a field before there is a protocol to justify it explains nothing.
   */
  const chosenProtocol = catalogOptions.find((c) => c.id === harnessCatalogId)?.protocol;
  const pins = chosenProtocol ? HARNESS_PROTOCOL_PINS[chosenProtocol] : { model: true, mode: true };

  // Preselect once the list loads. A Workspace now ships with two entries (Claude Code and
  // opencode), so this picks the first rather than "the only one" — the Owner still chooses, and
  // the protocol line under the picker is what tells them the two differ.
  useEffect(() => {
    if (!harnessCatalogId && catalogOptions[0]) setHarnessCatalogId(catalogOptions[0].id);
  }, [harnessCatalogId, catalogOptions]);

  const create = trpc.profile.agent.create.useMutation({
    onSuccess: () => {
      utils.profile.agent.list.invalidate();
      setName("");
      setSecretId("");
    },
  });

  // A second catalog row, most of the time, means naming an ACP-speaking binary (a native ACP
  // harness, or a bridge like claude-agent-acp) so a Profile can finally point at the protocol
  // that has a real permission channel. Kept as its own form rather than folded into the one
  // above: creating a catalog entry and creating a Profile that uses it are different acts —
  // one names a harness this Workspace CAN run, the other decides that THIS Workspace runs it,
  // with which credential and what concurrency.
  const [catalogKey, setCatalogKey] = useState("");
  const [catalogDisplayName, setCatalogDisplayName] = useState("");
  const [catalogProtocol, setCatalogProtocol] = useState<HarnessProtocol>("acp");
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
   * Nothing verified a Profile until a run failed on it — a misspelled command, a harness that
   * was never installed, a Secret pointing at a revoked key all looked identical to a working
   * Profile until a Task was queued, worktreed, briefed and then lost. The catalog list is
   * invalidated on success because a successful probe also fills the capability cache the pin
   * pickers read, so the model and mode lists can go from empty to populated without a run.
   */
  const [probed, setProbed] = useState<Record<string, HarnessProbeReport>>({});
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

  /**
   * A pending permission *increase*, held until the Owner confirms it.
   *
   * Only one direction is gated. Moving a profile to "read only" or "asks first" takes something
   * away and can be undone by moving it back; moving it to "never asks" hands a harness the shell
   * and the network for every future run, and that used to happen on a single unconfirmed click of
   * a grey dropdown — on a page where deleting the same profile asked twice.
   */
  const [escalation, setEscalation] = useState<{
    id: string;
    name: string;
    to: HarnessPermissionMode;
  } | null>(null);

  const requestPermissionChange = (
    profile: { id: string; name: string; permissionMode: HarnessPermissionMode },
    to: HarnessPermissionMode,
  ) => {
    if (to === profile.permissionMode) return;
    if (PERMISSION_RANK[to] > PERMISSION_RANK[profile.permissionMode]) {
      setEscalation({ id: profile.id, name: profile.name, to });
      return;
    }
    updateProfile.mutate({ id: profile.id, permissionMode: to });
  };

  const secretOptions = secrets.data ?? [];

  const rows = profiles.data?.items ?? [];
  const running = rows.reduce((n, p) => n + p.usage.runningCount, 0);
  const parked = rows.reduce((n, p) => n + p.usage.parkedCount, 0);
  const capacity = rows.reduce((n, p) => n + p.concurrencyCap, 0);

  return (
    <SettingsSection
      caption="Which harness runs, how it authenticates, and how many of it may run at once."
      id="agent-profiles"
      status={
        profiles.isSuccess ? (
          /*
            The reading this whole section exists to give, and which it never gave before: a
            concurrency cap is only meaningful against the slots currently spending it. Parked
            outranks running in the tone, because Parked is the state a cap *causes* — it means
            work is waiting on a ceiling set right here.
          */
          <SectionStatus tone={parked > 0 ? "waiting" : running > 0 ? "active" : "idle"}>
            {rows.length === 0
              ? "None configured"
              : parked > 0
                ? `${running} of ${capacity} running · ${parked} parked`
                : `${running} of ${capacity} running`}
          </SectionStatus>
        ) : null
      }
      title="Harness profiles"
    >
      {profiles.isPending ? (
        <SettingsLoading rows={2} />
      ) : rows.length === 0 ? (
        <SettingsEmpty>
          No harness profiles yet. One binds a stored secret to the harness that spends it.
        </SettingsEmpty>
      ) : (
        <SettingsRows>
          {rows.map((p) => {
            const inUse = describeHarnessProfileUsage(p.usage);
            const stale = stalePinOn(p, catalogOptions);
            const probe = probed[p.id];
            const unattended = p.permissionMode === "bypassPermissions";
            return (
              <SettingsRow
                actions={
                  <>
                    {/*
                      Deliberately never disabled — a Profile that is in use is the one it is most
                      urgent to be able to test, and "in use" is not evidence that it still works.
                    */}
                    <Button
                      aria-label={`Test the harness profile ${p.name}`}
                      loading={
                        probeProfile.isPending && probeProfile.variables?.agentProfileId === p.id
                      }
                      onClick={() => probeProfile.mutate({ agentProfileId: p.id })}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Stethoscope />
                    </Button>
                    <span
                      className="inline-flex"
                      title={inUse ? `Used by ${inUse}. Detach those first.` : undefined}
                    >
                      <ConfirmAction
                        confirmLabel="Delete profile"
                        description="This cannot be undone. Deleting a Profile does not touch the Secret it spends — only the binding between them."
                        disabled={inUse.length > 0}
                        onConfirm={() => deleteProfile.mutate({ id: p.id })}
                        title={`Delete "${p.name}"?`}
                        trigger={
                          <Button
                            aria-label={`Delete the harness profile ${p.name}`}
                            disabled={inUse.length > 0}
                            loading={
                              deleteProfile.isPending && deleteProfile.variables?.id === p.id
                            }
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 />
                          </Button>
                        }
                      />
                    </span>
                  </>
                }
                key={p.id}
                meta={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>
                      {p.authMode} · cap {p.concurrencyCap}
                    </span>
                    {/*
                      The permissive mode is the one that gets marked now, and it is marked with
                      the destructive token and its own glyph.

                      It used to be the other way round: only the *cautious* modes were badged, in
                      amber, so a list of ten profiles lit up the safe rows and left the ones that
                      run the shell and the network unasked completely unmarked. In a scan, the
                      signal pointed at exactly the wrong rows. Colour is never alone — the glyph
                      and the words carry it too (the Never Colour Alone Rule).
                    */}
                    {unattended ? (
                      <span className="inline-flex items-center gap-1 font-medium text-destructive">
                        <ShieldAlert aria-hidden className="size-3" />
                        Never asks
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {p.permissionMode === "plan" ? "Read only" : "Asks first"}
                      </span>
                    )}
                    {(p.model || p.modeId) && (
                      <span className="font-mono text-2xs">
                        {[p.model, p.modeId].filter(Boolean).join(" · ")}
                      </span>
                    )}
                    {stale && (
                      <span
                        className="text-feedback-error"
                        title="This harness's last handshake did not advertise it. The run will say so and use the harness's own choice — edit the pin here to fix it."
                      >
                        {stale} no longer advertised
                      </span>
                    )}
                    {inUse && <span className="truncate">Used by {inUse}</span>}
                  </span>
                }
                status={
                  <div className="flex items-center gap-2">
                    {probe && (
                      <SectionStatus tone={probe.ok ? "idle" : "bad"}>
                        {probeSummary(probe)}
                      </SectionStatus>
                    )}
                    <SectionStatus
                      tone={
                        p.usage.parkedCount > 0
                          ? "waiting"
                          : p.usage.runningCount > 0
                            ? "active"
                            : "idle"
                      }
                    >
                      {p.usage.parkedCount > 0
                        ? `${p.usage.runningCount} of ${p.concurrencyCap} · ${p.usage.parkedCount} parked`
                        : `${p.usage.runningCount} of ${p.concurrencyCap} running`}
                    </SectionStatus>
                    <Select
                      onValueChange={(v) => requestPermissionChange(p, v as HarnessPermissionMode)}
                      value={p.permissionMode}
                    >
                      <SelectTrigger
                        aria-label={`Permission mode for ${p.name}`}
                        className="w-40 shrink-0"
                        size="sm"
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
                  </div>
                }
                title={p.name}
              />
            );
          })}
        </SettingsRows>
      )}
      {deleteProfile.error && (
        <p className="text-destructive text-sm" role="alert">
          {deleteProfile.error.message}
        </p>
      )}

      {/*
        Raising what a harness may do without asking is a decision, not a setting.

        The select used to write straight through on change: one unconfirmed click took a profile
        from "asks first" to running the shell and the network unattended, while *deleting* that
        same profile was confirmed. Lowering it needs no ceremony — only the direction that grants
        more is stopped, and the words are the ones already written for the field below.
      */}
      <ConfirmDialog
        confirmLabel="Grant it"
        description={escalation ? PERMISSION_ESCALATION_COPY[escalation.to] : ""}
        onConfirm={() => {
          if (escalation) {
            updateProfile.mutate({ id: escalation.id, permissionMode: escalation.to });
          }
          setEscalation(null);
        }}
        onOpenChange={(open) => {
          if (!open) setEscalation(null);
        }}
        open={escalation !== null}
        title={
          escalation
            ? `Let "${escalation.name}" do more without asking?`
            : "Let this profile do more without asking?"
        }
      />

      <SettingsCreate
        defaultOpen={profiles.isSuccess && rows.length === 0}
        label="Add a harness profile"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              name,
              agentCatalogId: harnessCatalogId,
              authMode,
              secretId,
              concurrencyCap: cap,
              permissionMode,
              // Trimmed to null rather than sent as "": an empty pin is the absence of one, and
              // storing a blank string would make "no model" and "a model named nothing" the
              // same row.
              //
              // Dropped entirely when the chosen protocol cannot be told it: the field is
              // disabled, but a value typed against one harness and then left behind by switching
              // to another would still be in state, and storing it would put a pin on the
              // Profile that every run reports it could not honour.
              model: pins.model && model.trim() !== "" ? model.trim() : null,
              modeId: pins.mode && modeId.trim() !== "" ? modeId.trim() : null,
            });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="harness-name">Name</Label>
            <Input
              id="harness-name"
              placeholder="e.g. Claude Code"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="harness-catalog">Harness</Label>
            <Select value={harnessCatalogId} onValueChange={setHarnessCatalogId}>
              <SelectTrigger className="w-full" id="harness-catalog">
                <SelectValue placeholder="Select a harness" />
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
              is created. With more than one harness seeded it stops being a constant: Claude Code
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
              <Label htmlFor="harness-authmode">Auth mode</Label>
              <Select value={authMode} onValueChange={(v) => setAuthMode(v as AuthMode)}>
                <SelectTrigger id="harness-authmode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="api_key">API key</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="harness-cap">Concurrency cap</Label>
              <Input
                id="harness-cap"
                type="number"
                min={1}
                max={20}
                value={cap}
                onChange={(e) => setCap(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="harness-secret">Secret</Label>
            <Select value={secretId} onValueChange={setSecretId}>
              <SelectTrigger id="harness-secret" className="w-full">
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
              cache of what this harness advertised at its last handshake: present after a first
              run, empty before one, and never guaranteed complete. A dropdown would claim the
              list is closed and offer nothing at all on a fresh install; a datalist suggests
              what is known and still accepts what is not, which is exactly the contract.
            */}
            <div className="grid gap-2">
              <Label htmlFor="harness-model">Model</Label>
              <Input
                id="harness-model"
                list="harness-model-options"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={!pins.model}
                placeholder={
                  pins.model ? "the harness's own choice" : "this harness's protocol cannot be told"
                }
              />
              <datalist id="harness-model-options">
                {advertised.models.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="harness-mode">Mode</Label>
              <Input
                id="harness-mode"
                list="harness-mode-options"
                value={modeId}
                onChange={(event) => setModeId(event.target.value)}
                disabled={!pins.mode}
                placeholder={
                  pins.mode ? "the harness's own default" : "this harness's protocol cannot be told"
                }
              />
              <datalist id="harness-mode-options">
                {advertised.modes.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </div>
          </div>
          {/*
            Said once, under both: which of the two a harness can actually be told is a property
            of its protocol, and a Profile that pins the one its protocol cannot select would
            otherwise look like it had taken effect.
          */}
          <p className="text-muted-foreground text-xs leading-relaxed">
            Left empty, the harness chooses. A pin the harness's protocol cannot select is reported
            in the run's log rather than silently ignored.
          </p>
          <div className="grid gap-2">
            <Label htmlFor="harness-permission">Permission mode</Label>
            <Select
              value={permissionMode}
              onValueChange={(v) => setPermissionMode(v as HarnessPermissionMode)}
            >
              <SelectTrigger id="harness-permission" className="w-full">
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
            {/*
              The default, said out loud at the field that carries it.

              A new Profile arrives on "Never ask", and until now nothing on screen admitted that
              or explained it — a permissive default arriving silently through a grey dropdown is
              the only version of this that can surprise someone. It is a deliberate choice with a
              real reason, so the reason belongs here rather than in the contract's comments.
            */}
            {permissionMode === DEFAULT_HARNESS_PERMISSION_MODE && (
              <p className="flex items-start gap-1.5 text-feedback-caution text-xs leading-relaxed">
                <ShieldAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
                This is the default. SoloW runs harnesses headless, so under any asking mode the
                prompt reaches nobody and the task stalls part-done — pick another mode if this
                profile should propose rather than act.
              </p>
            )}
          </div>
          <Button
            type="submit"
            loading={create.isPending}
            disabled={secretOptions.length === 0 || !secretId || !harnessCatalogId}
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
            <span className="font-medium">Add a custom harness</span>
            <span className="text-2xs text-muted-foreground">
              Name a new protocol/command a Harness Profile can point at
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
                  onValueChange={(v) => setCatalogProtocol(v as HarnessProtocol)}
                >
                  <SelectTrigger id="catalog-protocol" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  {/*
                    Derived from the enum, not listed by hand: this was the one place adding a
                    protocol broke silently in JSX, where no compiler was ever going to say so.
                  */}
                  <SelectContent>
                    {harnessProtocolSchema.options.map((protocol) => (
                      <SelectItem key={protocol} value={protocol}>
                        {HARNESS_PROTOCOLS[protocol].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p
                  className={cn(
                    "text-2xs",
                    catalogProtocol === "acp" ? "text-feedback-ok" : "text-muted-foreground",
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
                  Resolved on PATH when a Task using this harness launches — install it on the
                  machine running the orchestrator first.
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
                Whichever of these two a Harness Profile's auth mode does not use is stripped from
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
      </SettingsCreate>
    </SettingsSection>
  );
}
