"use client";

import type { SecretKind } from "@gatecontrol/contracts";
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
import { trpc } from "@/trpc/react";

/** Set (write-only) Secrets and list their metadata — the value is never shown after entry. */
export function SecretsSection() {
  const utils = trpc.useUtils();
  const secrets = trpc.secret.list.useQuery({});
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SecretKind>("api_key");
  const [value, setValue] = useState("");

  const setSecret = trpc.secret.set.useMutation({
    onSuccess: () => {
      utils.secret.list.invalidate();
      setName("");
      setValue("");
    },
  });

  return (
    <Card id="secrets" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Secrets</CardTitle>
        <CardDescription>
          Write-only credentials. The value is never shown after entry.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setSecret.mutate({ name, kind, value });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="secret-name">Name</Label>
            <Input
              id="secret-name"
              placeholder="e.g. anthropic-api-key"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="secret-kind">Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as SecretKind)}>
              <SelectTrigger id="secret-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="api_key">API key</SelectItem>
                <SelectItem value="subscription_token">Subscription token</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="secret-value">Value</Label>
            <Input
              id="secret-value"
              type="password"
              placeholder="Paste the secret value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={setSecret.isPending}>
            {setSecret.isPending ? "Saving…" : "Save secret"}
          </Button>
        </form>
        {setSecret.error && (
          <p className="text-destructive text-sm" role="alert">
            {setSecret.error.message}
          </p>
        )}
        {(secrets.data?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {(secrets.data ?? []).map((s) => (
              <Badge key={s.id} variant="secondary">
                {s.name} · {s.kind}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
