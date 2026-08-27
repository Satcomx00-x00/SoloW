"use client";

import type { SecretKind, SecretRefDto } from "@solow/contracts";
import { Trash2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
import { trpc } from "@/trpc/react";

/**
 * How a Secret's holders read in the list and in the confirmation. Named rather than counted:
 * "used by github, claude" tells the user what to detach; "used by 2 things" does not.
 */
function describeUsage(usedBy: SecretRefDto["usedBy"]): string {
  return usedBy.map((u) => u.name).join(", ");
}

/**
 * Set (write-only) Secrets and list their metadata — the value is never shown after entry.
 *
 * `?renewSecret=<name>` is the landing page for the "Renew" action a credential-expired Task
 * card offers (spec AC-013, issue #63): renewing a credential is just setting the same Secret
 * again, so this pre-fills the name (and, once the list has loaded, the matching kind) rather
 * than sending the Owner to a blank form they have to fill in from memory. The query param is
 * read once — after that the fields are the Owner's own edits to keep.
 */
export function SecretsSection() {
  const utils = trpc.useUtils();
  const secrets = trpc.secret.list.useQuery({});
  const renewTarget = useSearchParams().get("renewSecret");
  const [name, setName] = useState(renewTarget ?? "");
  const [kind, setKind] = useState<SecretKind>("api_key");
  const [value, setValue] = useState("");
  const [justResumed, setJustResumed] = useState<number | null>(null);

  const valueRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const prefilled = useRef(false);

  // Runs once the matching Secret's real kind is known, not on the raw query param alone — a
  // renewal must submit the same kind the existing row has, and guessing "api_key" by default
  // would silently change it. Scrolling and focusing the moment the target is known, rather than
  // waiting on the list, is what makes this feel like the one click the card promised instead of
  // two: a click into Settings, then hunting for the row by hand.
  useEffect(() => {
    if (!renewTarget || prefilled.current) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    valueRef.current?.focus();
    const existing = secrets.data?.find((s) => s.name === renewTarget);
    if (existing) {
      prefilled.current = true;
      // Deferred a tick rather than set synchronously here. Landing on this page by a client-
      // side <Link> transition (as the Renew action does) mounts `Select` and calls `setKind`
      // on the very same paint — before Radix's own mount effect has registered `SelectItem`'s
      // label with the trigger, so the value is set correctly but the visible text stays blank
      // and never self-corrects. A hard page load has enough of a gap between mount and this
      // effect for Radix to have already registered it, which is why the bug does not reproduce
      // there. `setTimeout(0)` — a macrotask — runs after that mount effect, every time.
      setTimeout(() => setKind(existing.kind), 0);
    }
  }, [renewTarget, secrets.data]);

  const setSecret = trpc.secret.set.useMutation({
    onSuccess: ({ resumedTaskCount }) => {
      utils.secret.list.invalidate();
      utils.task.invalidate();
      setName("");
      setValue("");
      setJustResumed(resumedTaskCount > 0 ? resumedTaskCount : null);
    },
  });

  const deleteSecret = trpc.secret.delete.useMutation({
    onSuccess: () => utils.secret.list.invalidate(),
  });

  return (
    <Card id="secrets" className="scroll-mt-16" ref={cardRef}>
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
                <SelectItem value="scm_pat">Personal access token (GitHub/GitLab)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="secret-value">Value</Label>
            <Input
              id="secret-value"
              ref={valueRef}
              type="password"
              placeholder="Paste the secret value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </div>
          <Button type="submit" loading={setSecret.isPending}>
            Save secret
          </Button>
        </form>
        {setSecret.error && (
          <p className="text-destructive text-sm" role="alert">
            {setSecret.error.message}
          </p>
        )}
        {justResumed !== null && (
          <p className="text-sm text-state-done" role="status">
            Saved. {justResumed} task{justResumed === 1 ? "" : "s"} paused on this credential{" "}
            {justResumed === 1 ? "has" : "have"} resumed.
          </p>
        )}
        {(secrets.data?.length ?? 0) > 0 && (
          <ul className="divide-y border-t">
            {(secrets.data ?? []).map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{s.name}</p>
                  {s.usedBy.length > 0 && (
                    <p className="truncate text-muted-foreground text-xs">
                      Used by {describeUsage(s.usedBy)}
                    </p>
                  )}
                </div>
                <Badge variant="secondary">{s.kind}</Badge>
                {/*
                  A Secret in use is not deletable at all — the server refuses it, and a button
                  that only ever produces an error is worse than one that explains itself. The
                  reason sits beside it in the row above, so the disabled state is never a mystery.
                */}
                <ConfirmAction
                  title={`Delete "${s.name}"?`}
                  description="The stored value is encrypted and cannot be read back, so deleting it is permanent — you would have to obtain the credential again from wherever it came from."
                  confirmLabel="Delete secret"
                  disabled={s.usedBy.length > 0}
                  onConfirm={() => deleteSecret.mutate({ id: s.id })}
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={s.usedBy.length > 0}
                      aria-label={`Delete the secret ${s.name}`}
                      loading={deleteSecret.isPending && deleteSecret.variables?.id === s.id}
                    >
                      <Trash2 />
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {deleteSecret.error && (
          <p className="text-destructive text-sm" role="alert">
            {deleteSecret.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
