"use client";

import { UserCheck } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/trpc/react";

/**
 * Who you are on each connected provider (spec F23 FR-11) — what `assignee:@me` resolves to.
 *
 * The planning table's `My items` tab filters against the assignee logins the provider mirrored
 * onto each row. A GateControl account name is not one of those, so until this is stated the tab
 * matches on coincidence: empty for almost everyone, and quietly right for the one person whose
 * two names happen to agree.
 *
 * **Why you type it instead of GateControl reading it off the token.** The token belongs to the
 * Workspace, not to you: whoever connected the Integration issued it, and everyone here reads
 * through it. So the provider's "who am I" endpoint answers *who issued this token* — which for
 * everyone else in the Workspace is somebody else's name, under a tab called `My items`. That is
 * a wrong answer nobody can see, which is worse than no answer. The page says this out loud
 * rather than leaving it as a surprise, because "why is this not filled in for me" is the first
 * question the form invites.
 *
 * One mapping per Integration, not per provider: the same person is a different login on a
 * company's own host than on the public one, and both can be connected at once.
 */
export function ProviderIdentitySection() {
  const utils = trpc.useUtils();
  const integrations = trpc.integration.list.useQuery({});
  const identities = trpc.identity.list.useQuery({});

  /**
   * What is typed, per Integration — held only for the rows someone has edited.
   *
   * An empty draft map means every input shows the stored login, so a mapping saved on another
   * device shows up on a refetch instead of being pinned to whatever this tab loaded with.
   */
  const [typed, setTyped] = useState<Record<string, string>>({});

  const invalidate = () => {
    void utils.identity.list.invalidate();
    // The projects table reads its `@me` from this mapping; without this the tab it names would
    // keep matching nothing until something else happened to refetch.
    void utils.identity.forProject.invalidate();
  };

  const save = trpc.identity.set.useMutation({
    onSuccess: (saved) => {
      setTyped((current) => {
        const { [saved.integrationId]: _saved, ...rest } = current;
        return rest;
      });
      invalidate();
    },
  });
  const clear = trpc.identity.clear.useMutation({
    onSuccess: (cleared) => {
      setTyped((current) => {
        const { [cleared.integrationId]: _cleared, ...rest } = current;
        return rest;
      });
      invalidate();
    },
  });

  const storedFor = (integrationId: string) =>
    (identities.data ?? []).find((i) => i.integrationId === integrationId)?.login ?? null;

  const connected = integrations.data ?? [];

  return (
    <Card id="provider-identity" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Your provider logins</CardTitle>
        <CardDescription>
          What <code className="font-mono text-xs">@me</code> means in a project filter. Each
          connection&apos;s token belongs to the workspace, not to you — it names whoever issued it
          — so your own login on that provider is something you state here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {connected.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No integration connected yet. Connect one above, then say who you are on it.
          </p>
        ) : (
          <ul className="space-y-4">
            {connected.map((integration) => {
              const stored = storedFor(integration.id);
              const value = typed[integration.id] ?? stored ?? "";
              const trimmed = value.trim();
              const inputId = `provider-login-${integration.id}`;
              return (
                <li key={integration.id} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">
                      {integration.provider} · {integration.baseUrl ?? "cloud"}
                    </Badge>
                    {stored && (
                      <span className="flex items-center gap-1 text-muted-foreground text-xs">
                        <UserCheck aria-hidden className="size-3.5" /> {stored}
                      </span>
                    )}
                  </div>
                  <form
                    className="flex flex-wrap items-end gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!trimmed) return;
                      save.mutate({ integrationId: integration.id, login: trimmed });
                    }}
                  >
                    <div className="grid gap-2">
                      <Label htmlFor={inputId}>Your login on {integration.provider}</Label>
                      <Input
                        id={inputId}
                        className="w-64"
                        value={value}
                        placeholder="the name in your profile URL"
                        onChange={(e) =>
                          setTyped((current) => ({ ...current, [integration.id]: e.target.value }))
                        }
                      />
                    </div>
                    <Button
                      type="submit"
                      size="sm"
                      loading={save.isPending && save.variables?.integrationId === integration.id}
                      disabled={!trimmed || trimmed === stored}
                    >
                      Save
                    </Button>
                    {stored && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        loading={
                          clear.isPending && clear.variables?.integrationId === integration.id
                        }
                        onClick={() => clear.mutate({ integrationId: integration.id })}
                      >
                        Forget
                      </Button>
                    )}
                  </form>
                  {!stored && (
                    /* Named as a consequence rather than as a warning: an unstated mapping is a
                       perfectly ordinary state, it just makes one tab match nothing. */
                    <p className="text-muted-foreground text-xs">
                      Until this is set, <code className="font-mono">assignee:@me</code> matches no
                      rows in projects from this connection.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {save.error && (
          <p className="text-destructive text-sm" role="alert">
            {save.error.message}
          </p>
        )}
        {clear.error && (
          <p className="text-destructive text-sm" role="alert">
            {clear.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
