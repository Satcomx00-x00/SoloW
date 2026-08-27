"use client";

import type { ExecutorConfig, ExecutorKind, ExecutorProfileDto } from "@solow/contracts";
import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";
import { type EnvPair, EnvRows, fromEnvPairs, toEnvPairs } from "./env-rows";

/**
 * Executor Profiles (issue #73). The form **renders from the selected kind**: one `Select` for
 * the kind, then the fields that kind's configuration schema declares. That is why the form is
 * driven off a single `ExecutorConfig` state object rather than one `useState` per field — a new
 * kind is a new branch here and a new union member in the contract, not a form rewrite.
 *
 * Only kinds with a driver can actually run today (local); the others are configurable ahead of
 * their drivers (#96 Docker, #97 SSH), and the orchestrator fails a Task pointed at one rather
 * than silently running it on the host.
 */

const KIND_LABELS: Record<ExecutorKind, string> = {
  local: "Local",
  docker: "Docker",
  ssh: "Remote SSH",
  cloud: "Cloud",
};

/** Kinds a driver exists for. Mirrors `AVAILABLE_EXECUTOR_KINDS` in the orchestrator. */
const RUNNABLE_KINDS: readonly ExecutorKind[] = ["local"];

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

export function ExecutorProfilesSection() {
  const utils = trpc.useUtils();
  const list = trpc.profile.executor.list.useQuery({ ...WHOLE_PAGE });
  const secrets = trpc.secret.list.useQuery({});

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<ExecutorConfig>(blankConfig("local", {}));
  const [envPairs, setEnvPairs] = useState<EnvPair[]>([]);

  const reset = () => {
    setEditingId(null);
    setName("");
    setConfig(blankConfig("local", {}));
    setEnvPairs([]);
  };

  const onSaved = () => {
    utils.profile.executor.list.invalidate();
    reset();
  };
  const create = trpc.profile.executor.create.useMutation({ onSuccess: onSaved });
  const update = trpc.profile.executor.update.useMutation({ onSuccess: onSaved });
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const edit = (profile: ExecutorProfileDto) => {
    setEditingId(profile.id);
    setName(profile.name);
    setConfig(profile.config);
    setEnvPairs(toEnvPairs(profile.config.env));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // An emptied textarea means "no prepare script", not "run an empty one".
    const { prepareScript, ...rest } = config;
    const payload = {
      ...rest,
      ...(prepareScript?.trim() ? { prepareScript } : {}),
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

  return (
    <Card className="scroll-mt-16" id="executor-profiles">
      <CardHeader>
        <CardTitle>Executor profiles</CardTitle>
        <CardDescription>
          Where agents run, and the configuration they run under. Only the local kind has a driver
          today.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
            <div className="grid gap-2">
              <Label htmlFor="executor-image">Image</Label>
              <Input
                id="executor-image"
                onChange={(e) => setConfig({ ...config, image: e.target.value })}
                placeholder="e.g. oven/bun:1.3"
                required
                value={config.image}
              />
            </div>
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

        {(list.data?.items.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {(list.data?.items ?? []).map((p) => (
              <Button key={p.id} onClick={() => edit(p)} size="sm" type="button" variant="ghost">
                <Badge variant="secondary">
                  {p.name} · {KIND_LABELS[p.kind]}
                </Badge>
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
