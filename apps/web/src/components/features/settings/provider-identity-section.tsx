"use client";

import { UserCheck } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/trpc/react";
import {
  SectionStatus,
  SettingsEmpty,
  SettingsField,
  SettingsLoading,
  SettingsSection,
} from "./settings-shell";

/**
 * Who you are on each connected provider (spec F23 FR-11) — what `assignee:@me` resolves to.
 *
 * The planning table's `My items` tab filters against the assignee logins the provider mirrored
 * onto each row. A SoloW account name is not one of those, so until this is stated the tab
 * matches on coincidence: empty for almost everyone, and quietly right for the one person whose
 * two names happen to agree.
 *
 * **Why you type it instead of SoloW reading it off the token.** The token belongs to the
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

  const named = connected.filter((i) => storedFor(i.id) !== null).length;

  return (
    <SettingsSection
      caption="What @me means in a project filter. Each connection’s token belongs to the workspace, not to you — it names whoever issued it — so your own login on that provider is something you state here."
      id="provider-identity"
      status={
        integrations.isSuccess && identities.isSuccess ? (
          // The one that is *not* set is the interesting one: it is the connection whose
          // `assignee:@me` silently matches nothing.
          <SectionStatus tone={named < connected.length ? "waiting" : "idle"}>
            {connected.length === 0 ? "No connections" : `${named} of ${connected.length} named`}
          </SectionStatus>
        ) : null
      }
      title="Your provider logins"
    >
      {integrations.isPending ? (
        <SettingsLoading rows={2} />
      ) : connected.length === 0 ? (
        <SettingsEmpty>
          No integration connected yet. Connect one first, then say who you are on it.
        </SettingsEmpty>
      ) : (
        <ul className="-mx-1 divide-y">
          {connected.map((integration) => {
            const stored = storedFor(integration.id);
            const value = typed[integration.id] ?? stored ?? "";
            const trimmed = value.trim();
            const inputId = `provider-login-${integration.id}`;
            return (
              <li className="space-y-2 px-1 py-3 first:pt-0 last:pb-0" key={integration.id}>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">
                    {integration.provider} · {integration.baseUrl ?? "cloud"}
                  </Badge>
                  {stored ? (
                    <span className="flex items-center gap-1 text-muted-foreground text-xs">
                      <UserCheck aria-hidden className="size-3.5" /> {stored}
                    </span>
                  ) : (
                    <SectionStatus tone="waiting">Not set</SectionStatus>
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
                  <SettingsField htmlFor={inputId} label={`Your login on ${integration.provider}`}>
                    <Input
                      className="w-64"
                      id={inputId}
                      onChange={(e) =>
                        setTyped((current) => ({ ...current, [integration.id]: e.target.value }))
                      }
                      placeholder="the name in your profile URL"
                      value={value}
                    />
                  </SettingsField>
                  <Button
                    disabled={!trimmed || trimmed === stored}
                    loading={save.isPending && save.variables?.integrationId === integration.id}
                    size="sm"
                    type="submit"
                  >
                    Save
                  </Button>
                  {stored && (
                    <Button
                      loading={clear.isPending && clear.variables?.integrationId === integration.id}
                      onClick={() => clear.mutate({ integrationId: integration.id })}
                      size="sm"
                      type="button"
                      variant="ghost"
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
    </SettingsSection>
  );
}
