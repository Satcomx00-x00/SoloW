"use client";

import type { SecretKind } from "@gatecontrol/contracts";
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
      <CardContent className="space-y-3">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSecret.mutate({ name, kind, value });
          }}
        >
          <Input
            aria-label="Secret name"
            placeholder="e.g. anthropic-api-key"
            className="max-w-48"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Select value={kind} onValueChange={(v) => setKind(v as SecretKind)}>
            <SelectTrigger aria-label="Secret kind" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="api_key">API key</SelectItem>
              <SelectItem value="subscription_token">Subscription token</SelectItem>
            </SelectContent>
          </Select>
          <Input
            aria-label="Secret value"
            type="password"
            placeholder="value"
            className="max-w-48"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
          <Button type="submit" disabled={setSecret.isPending}>
            {setSecret.isPending ? "Saving…" : "Save secret"}
          </Button>
        </form>
        {setSecret.error && (
          <p className="text-destructive text-sm" role="alert">
            {setSecret.error.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(secrets.data ?? []).map((s) => (
            <Badge key={s.id} variant="secondary">
              {s.name} · {s.kind}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
