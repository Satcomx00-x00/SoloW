"use client";

import type { ExecutorConfig, ExecutorKind, ExecutorProfileDto } from "@solow/contracts";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
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
import { Textarea } from "@/components/ui/textarea";
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";
import { type EnvPair, EnvRows, fromEnvPairs, toEnvPairs } from "./env-rows";
import { fromMountRows, type MountRow, MountRows, toMountRows } from "./mount-rows";
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
 * Executor Profiles (issue #73). The form **renders from the selected kind**: one `Select` for
 * the kind, then the fields that kind's configuration schema declares. That is why the form is
 * driven off a single `ExecutorConfig` state object rather than one `useState` per field — a new
 * kind is a new branch here and a new union member in the contract, not a form rewrite.
 *
 * Only kinds with a driver can actually run today (local and Docker); the others are configurable
 * ahead of their drivers (#97 SSH, #107 Kubernetes), and the orchestrator fails a Task pointed at
 * one rather than silently running it on the host.
 */

const KIND_LABELS: Record<ExecutorKind, string> = {
  local: "Local",
  docker: "Docker",
  ssh: "Remote SSH",
  cloud: "Cloud",
};

/** Kinds a driver exists for. Mirrors `AVAILABLE_EXECUTOR_KINDS` in the orchestrator. */
const RUNNABLE_KINDS: readonly ExecutorKind[] = ["local", "docker"];

/**
 * Switch kinds without losing what the two kinds have in common. The prepare script and the
 * environment are shared by every member, so retyping them after a mis-click would be the form
 * punishing the user for exploring.
 */
function blankConfig(
  kind: ExecutorKind,
  shared: { prepareScript?: string | undefined },
): ExecutorConfig {
  const base = {
    env: {},
    ...(shared.prepareScript ? { prepareScript: shared.prepareScript } : {}),
  };
  switch (kind) {
    case "local":
      return { kind, ...base };
    case "docker":
      return { kind, image: "", mounts: [], ...base };
    case "ssh":
      return { kind, host: "", port: 22, user: "", keySecretId: "", ...base };
    case "cloud":
      return { kind, provider: "", size: "", credentialSecretId: "", ...base };
  }
}

/**
 * Clear an optional field by removing it, never by writing an empty one.
 *
 * Every union member is `.strict()` and these fields are `.optional()`, so `network: ""` and
 * `cpus: 0` are *rejected* at the boundary rather than read as "unset" — which would turn
 * emptying a field the user had filled in into a save that fails with a schema error about a
 * field they just cleared.
 */
function withText<C extends ExecutorConfig, K extends keyof C>(
  config: C,
  field: K,
  raw: string,
): C {
  const next = { ...config };
  if (raw.trim() === "") delete next[field];
  else next[field] = raw as C[K];
  return next;
}

/** The same, for the two numeric limits — where an empty field means the daemon's default. */
function withNumber<C extends ExecutorConfig, K extends keyof C>(
  config: C,
  field: K,
  raw: string,
): C {
  const next = { ...config };
  if (raw.trim() === "" || Number.isNaN(Number(raw))) delete next[field];
  else next[field] = Number(raw) as C[K];
  return next;
}

export function ExecutorProfilesSection() {
  const utils = trpc.useUtils();
  const list = trpc.profile.executor.list.useQuery({ ...WHOLE_PAGE });
  const secrets = trpc.secret.list.useQuery({});

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<ExecutorConfig>(blankConfig("local", {}));
  const [envPairs, setEnvPairs] = useState<EnvPair[]>([]);
  // Beside the config rather than inside it, for the reason `mount-rows.tsx` states: a row being
  // typed is not yet a mount, and the contract would refuse a config carrying one.
  const [mountRows, setMountRows] = useState<MountRow[]>([]);

  const reset = () => {
    setEditingId(null);
    setName("");
    setConfig(blankConfig("local", {}));
    setEnvPairs([]);
    setMountRows([]);
  };

  const onSaved = () => {
    utils.profile.executor.list.invalidate();
    reset();
  };
  const create = trpc.profile.executor.create.useMutation({ onSuccess: onSaved });
  const update = trpc.profile.executor.update.useMutation({ onSuccess: onSaved });
  const remove = trpc.profile.executor.delete.useMutation({
    onSuccess: () => {
      utils.profile.executor.list.invalidate();
      // Editing the profile that has just been deleted would leave the form bound to a row the
      // server no longer has, and "Save changes" on it would fail with a not-found nobody expects.
      reset();
    },
  });
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const edit = (profile: ExecutorProfileDto) => {
    setEditingId(profile.id);
    setName(profile.name);
    setConfig(profile.config);
    setEnvPairs(toEnvPairs(profile.config.env));
    setMountRows(profile.config.kind === "docker" ? toMountRows(profile.config.mounts) : []);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // An emptied textarea means "no prepare script", not "run an empty one".
    const { prepareScript, ...rest } = config;
    const payload = {
      ...rest,
      ...(prepareScript?.trim() ? { prepareScript } : {}),
      ...(rest.kind === "docker" ? { mounts: fromMountRows(mountRows) } : {}),
      env: fromEnvPairs(envPairs),
    } as ExecutorConfig;
    if (editingId) update.mutate({ id: editingId, name, config: payload });
    else create.mutate({ name, config: payload });
  };

  /** Secrets are offered as a reference; the value never enters the configuration (AC-3). */
  const secretSelect = (value: string, onValueChange: (v: string) => void, id: string) => (
    <Select onValueChange={onValueChange} value={value}>
      <SelectTrigger className="w-full" id={id}>
        <SelectValue placeholder="Select a stored secret" />
      </SelectTrigger>
      <SelectContent>
        {(secrets.data ?? []).map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name} · {s.kind}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const rows = list.data?.items ?? [];
  const runnable = rows.filter((p) => RUNNABLE_KINDS.includes(p.kind)).length;

  return (
    <SettingsSection
      caption="Where a harness's commands actually run, and the configuration they run under. The local and Docker kinds have drivers today."
      id="executor-profiles"
      status={
        list.isSuccess ? (
          <SectionStatus tone={rows.length > 0 && runnable === 0 ? "bad" : "idle"}>
            {rows.length === 0 ? "None configured" : `${runnable} of ${rows.length} runnable`}
          </SectionStatus>
        ) : null
      }
      title="Executors"
    >
      {list.isPending ? (
        <SettingsLoading rows={2} />
      ) : rows.length === 0 ? (
        <SettingsEmpty>
          No executors configured. A Task needs one to say where its harness runs.
        </SettingsEmpty>
      ) : (
        <SettingsRows>
          {rows.map((p) => {
            const drivable = RUNNABLE_KINDS.includes(p.kind);
            return (
              <SettingsRow
                actions={
                  <>
                    {/*
                      A real button that says "Edit". Choosing an executor to edit used to mean
                      clicking the *badge* showing its name — a pill with no button affordance, no
                      label saying what clicking did, and no way to tell it apart from the dozens
                      of badges on this page that do nothing.
                    */}
                    <Button
                      onClick={() => edit(p)}
                      size="sm"
                      type="button"
                      variant={editingId === p.id ? "secondary" : "ghost"}
                    >
                      <Pencil />
                      Edit
                    </Button>
                    <ConfirmAction
                      confirmLabel="Delete executor"
                      description="The profile is removed. Nothing on the machine it described is touched — this only forgets how to reach it."
                      onConfirm={() => remove.mutate({ id: p.id })}
                      title={`Delete "${p.name}"?`}
                      trigger={
                        <Button
                          aria-label={`Delete the executor ${p.name}`}
                          loading={remove.isPending && remove.variables?.id === p.id}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 />
                        </Button>
                      }
                    />
                  </>
                }
                key={p.id}
                meta={KIND_LABELS[p.kind]}
                status={
                  <SectionStatus tone={drivable ? "idle" : "waiting"}>
                    {drivable ? "ready" : "no driver yet"}
                  </SectionStatus>
                }
                title={p.name}
              />
            );
          })}
        </SettingsRows>
      )}

      {remove.error && (
        <p className="text-destructive text-sm" role="alert">
          {remove.error.message}
        </p>
      )}

      {/*
        Remounted whenever the edited profile changes, which resets the disclosure's own
        open/closed override so that pressing Edit always reveals the form — even for someone who
        had folded it away a moment earlier.
      */}
      <SettingsCreate
        defaultOpen={editingId !== null || (list.isSuccess && rows.length === 0)}
        key={editingId ?? "new"}
        label={editingId ? "Editing an executor" : "Add an executor"}
      >
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="executor-name">Name</Label>
            <Input
              id="executor-name"
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Local executor"
              required
              value={name}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="executor-kind">Kind</Label>
            <Select
              onValueChange={(v) =>
                setConfig(
                  blankConfig(v as ExecutorKind, {
                    ...(config.prepareScript ? { prepareScript: config.prepareScript } : {}),
                  }),
                )
              }
              value={config.kind}
            >
              <SelectTrigger className="w-full" id="executor-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABELS) as ExecutorKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABELS[k]}
                    {RUNNABLE_KINDS.includes(k) ? "" : " · no driver yet"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {config.kind === "docker" && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="executor-image">Image</Label>
                <Input
                  id="executor-image"
                  onChange={(e) => setConfig({ ...config, image: e.target.value })}
                  placeholder="e.g. oven/bun:1.3"
                  required
                  value={config.image}
                />
                <p className="text-muted-foreground text-xs">
                  The image needs an ordinary shell userland — sh, env, cat, find, mkdir, cp, test,
                  df, base64 and git. A distroless or scratch image fails the Task before the
                  harness starts, saying which of them is missing.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="grid gap-2">
                  <Label htmlFor="executor-network">Network</Label>
                  <Input
                    id="executor-network"
                    onChange={(e) => setConfig(withText(config, "network", e.target.value))}
                    placeholder="daemon default"
                    value={config.network ?? ""}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="executor-cpus">CPUs</Label>
                  <Input
                    id="executor-cpus"
                    min={0}
                    onChange={(e) => setConfig(withNumber(config, "cpus", e.target.value))}
                    placeholder="no quota"
                    step="0.1"
                    type="number"
                    value={config.cpus ?? ""}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="executor-memory">Memory (MiB)</Label>
                  <Input
                    id="executor-memory"
                    min={6}
                    onChange={(e) => setConfig(withNumber(config, "memoryMb", e.target.value))}
                    placeholder="no limit"
                    type="number"
                    value={config.memoryMb ?? ""}
                  />
                </div>
              </div>
              <p className="text-muted-foreground text-xs">
                Left empty, the daemon&apos;s own defaults apply. A limit this host&apos;s kernel
                cannot enforce fails the Task rather than being quietly dropped — reporting an
                isolation you did not get would be worse than refusing it.
              </p>

              <MountRows onChange={setMountRows} rows={mountRows} />
            </>
          )}

          {config.kind === "ssh" && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 grid gap-2">
                  <Label htmlFor="executor-host">Host</Label>
                  <Input
                    id="executor-host"
                    onChange={(e) => setConfig({ ...config, host: e.target.value })}
                    required
                    value={config.host}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="executor-port">Port</Label>
                  <Input
                    id="executor-port"
                    max={65535}
                    min={1}
                    onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
                    type="number"
                    value={config.port}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="executor-user">User</Label>
                <Input
                  id="executor-user"
                  onChange={(e) => setConfig({ ...config, user: e.target.value })}
                  required
                  value={config.user}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="executor-key">Private key</Label>
                {secretSelect(
                  config.keySecretId,
                  (v) => setConfig({ ...config, keySecretId: v }),
                  "executor-key",
                )}
                <p className="text-muted-foreground text-xs">
                  A reference to a stored secret. The key itself is never held in the profile.
                </p>
              </div>
            </>
          )}

          {config.kind === "cloud" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-2">
                  <Label htmlFor="executor-provider">Provider</Label>
                  <Input
                    id="executor-provider"
                    onChange={(e) => setConfig({ ...config, provider: e.target.value })}
                    required
                    value={config.provider}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="executor-size">Size</Label>
                  <Input
                    id="executor-size"
                    onChange={(e) => setConfig({ ...config, size: e.target.value })}
                    required
                    value={config.size}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="executor-credential">Credential</Label>
                {secretSelect(
                  config.credentialSecretId,
                  (v) => setConfig({ ...config, credentialSecretId: v }),
                  "executor-credential",
                )}
              </div>
            </>
          )}

          <div className="grid gap-2">
            <Label htmlFor="executor-prepare">Prepare script</Label>
            <Textarea
              className="font-mono text-xs"
              id="executor-prepare"
              onChange={(e) => setConfig({ ...config, prepareScript: e.target.value })}
              placeholder="bun install"
              rows={3}
              value={config.prepareScript ?? ""}
            />
          </div>

          <EnvRows onChange={setEnvPairs} pairs={envPairs} />

          <div className="flex gap-2">
            <Button loading={pending} type="submit">
              {editingId ? "Save changes" : "Add executor"}
            </Button>
            {editingId && (
              <Button onClick={reset} type="button" variant="ghost">
                Cancel
              </Button>
            )}
          </div>
        </form>

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error.message}
          </p>
        )}
      </SettingsCreate>
    </SettingsSection>
  );
}
