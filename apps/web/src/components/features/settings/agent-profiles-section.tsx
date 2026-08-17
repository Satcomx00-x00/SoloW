"use client";

import type { AuthMode } from "@gatecontrol/contracts";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/trpc/react";

/** Create Agent Profiles (auth mode + concurrency cap) bound to a stored Secret. */
export function AgentProfilesSection() {
  const utils = trpc.useUtils();
  const profiles = trpc.profile.agent.list.useQuery({});
  const secrets = trpc.secret.list.useQuery({});
  const [name, setName] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("subscription");
  const [secretId, setSecretId] = useState("");
  const [cap, setCap] = useState(3);

  const create = trpc.profile.agent.create.useMutation({
    onSuccess: () => {
      utils.profile.agent.list.invalidate();
      setName("");
    },
  });

  const secretOptions = secrets.data ?? [];

  return (
    <Card id="agent-profiles" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Agent profiles</CardTitle>
        <CardDescription>Auth mode + concurrency cap, bound to a stored secret.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              name,
              agentKind: "claude_code",
              authMode,
              secretId,
              concurrencyCap: cap,
            });
          }}
        >
          <Input
            aria-label="Profile name"
            placeholder="e.g. Claude Code"
            className="max-w-48"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Select value={authMode} onValueChange={(v) => setAuthMode(v as AuthMode)}>
            <SelectTrigger aria-label="Auth mode" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="subscription">Subscription</SelectItem>
              <SelectItem value="api_key">API key</SelectItem>
            </SelectContent>
          </Select>
          <Select value={secretId} onValueChange={setSecretId}>
            <SelectTrigger aria-label="Secret" className="w-44">
              <SelectValue placeholder="Secret…" />
            </SelectTrigger>
            <SelectContent>
              {secretOptions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} ({s.kind})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Concurrency cap"
            type="number"
            min={1}
            max={20}
            className="w-20"
            value={cap}
            onChange={(e) => setCap(Number(e.target.value))}
          />
          <Button
            type="submit"
            disabled={create.isPending || secretOptions.length === 0 || !secretId}
          >
            Add profile
          </Button>
        </form>
        {secretOptions.length === 0 && (
          <p className="text-muted-foreground text-xs">Add a secret first to create a profile.</p>
        )}
        {create.error && (
          <p className="text-destructive text-sm" role="alert">
            {create.error.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(profiles.data ?? []).map((p) => (
            <Badge key={p.id} variant="secondary">
              {p.name} · {p.authMode} · cap {p.concurrencyCap}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
