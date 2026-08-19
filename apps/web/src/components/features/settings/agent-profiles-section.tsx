"use client";

import type { AuthMode } from "@gatecontrol/contracts";
import { useEffect, useState } from "react";
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
import { trpc } from "@/trpc/react";

/**
 * Create Agent Profiles: which agent (issue #10), auth mode + concurrency cap, bound to a
 * stored Secret.
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
        {(profiles.data?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {(profiles.data ?? []).map((p) => (
              <Badge key={p.id} variant="secondary">
                {p.name} · {p.authMode} · cap {p.concurrencyCap}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
