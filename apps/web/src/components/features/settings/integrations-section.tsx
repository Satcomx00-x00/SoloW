"use client";

import type { ScmProvider } from "@gatecontrol/contracts";
import { RefreshCw } from "lucide-react";
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

/**
 * Connect GitHub/GitLab and link Repositories to them (issue #15). Once a Repository is linked,
 * the Issues page's Import dialog can pull real Issues from it, and "Sync now" here refreshes
 * its branches and change requests.
 */
export function IntegrationsSection() {
  const utils = trpc.useUtils();
  const integrations = trpc.integration.list.useQuery({});
  const secrets = trpc.secret.list.useQuery({});
  const repos = trpc.repository.list.useQuery({});
  const patSecrets = (secrets.data ?? []).filter((s) => s.kind === "scm_pat");

  const [provider, setProvider] = useState<ScmProvider>("github");
  const [secretId, setSecretId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  const connect = trpc.integration.connect.useMutation({
    onSuccess: () => {
      utils.integration.list.invalidate();
      setSecretId("");
      setBaseUrl("");
    },
  });

  const [linkTarget, setLinkTarget] = useState<{ repoId: string; integrationId: string }>({
    repoId: "",
    integrationId: "",
  });
  const [externalFullName, setExternalFullName] = useState("");

  /**
   * The repositories the selected Integration's token can actually see. Fetched only once an
   * Integration is chosen, because the query authenticates against that Integration's stored
   * token — there is nothing meaningful to list before then.
   */
  const externalRepos = trpc.integration.listExternalRepositories.useQuery(
    { integrationId: linkTarget.integrationId },
    { enabled: linkTarget.integrationId.length > 0 },
  );

  /**
   * Switching Integration must drop the chosen repository: a full name is only meaningful on the
   * Integration that listed it, and carrying it across would submit a name from account A against
   * account B — the exact mistake the picker exists to prevent.
   */
  const changeIntegration = (integrationId: string) => {
    setLinkTarget((t) => ({ ...t, integrationId }));
    setExternalFullName("");
  };

  const link = trpc.integration.linkRepository.useMutation({
    onSuccess: () => {
      utils.repository.list.invalidate();
      utils.integration.listExternalRepositories.invalidate();
      setExternalFullName("");
    },
  });

  const sync = trpc.integration.syncRepositorySignals.useMutation();

  return (
    <Card id="integrations" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
        <CardDescription>
          Connect GitHub or GitLab with a personal access token, then link a repository to import
          its Issues and sync its branches and change requests.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate({
              provider,
              secretId,
              ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="integration-provider">Provider</Label>
              <Select value={provider} onValueChange={(v) => setProvider(v as ScmProvider)}>
                <SelectTrigger className="w-full" id="integration-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="gitlab">GitLab</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="integration-secret">Personal access token</Label>
              <Select value={secretId} onValueChange={setSecretId}>
                <SelectTrigger className="w-full" id="integration-secret">
                  <SelectValue placeholder="Select a scm_pat secret" />
                </SelectTrigger>
                <SelectContent>
                  {patSecrets.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {patSecrets.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  Add a "Personal access token" secret above first.
                </p>
              )}
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="integration-base-url">
              Base URL <span className="text-muted-foreground">(self-hosted only)</span>
            </Label>
            <Input
              id="integration-base-url"
              placeholder="e.g. https://github.example.com or https://gitlab.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <Button type="submit" loading={connect.isPending} disabled={!secretId}>
            Connect
          </Button>
        </form>
        {connect.error && (
          <p className="text-destructive text-sm" role="alert">
            {connect.error.message}
          </p>
        )}

        {(integrations.data?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {(integrations.data ?? []).map((i) => (
              <Badge key={i.id} variant="secondary">
                {i.provider} · {i.baseUrl ?? "cloud"}
              </Badge>
            ))}
          </div>
        )}

        {(integrations.data?.length ?? 0) > 0 && (repos.data?.length ?? 0) > 0 && (
          <div className="space-y-3 border-t pt-4">
            <p className="font-medium text-sm">Link a repository</p>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!linkTarget.repoId || !linkTarget.integrationId) return;
                link.mutate({
                  repositoryId: linkTarget.repoId,
                  integrationId: linkTarget.integrationId,
                  externalFullName,
                });
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="link-repo">Repository</Label>
                <Select
                  value={linkTarget.repoId}
                  onValueChange={(v) => setLinkTarget((t) => ({ ...t, repoId: v }))}
                >
                  <SelectTrigger className="w-40" id="link-repo">
                    <SelectValue placeholder="Repository" />
                  </SelectTrigger>
                  <SelectContent>
                    {(repos.data ?? []).map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="link-integration">Integration</Label>
                <Select value={linkTarget.integrationId} onValueChange={changeIntegration}>
                  <SelectTrigger className="w-40" id="link-integration">
                    <SelectValue placeholder="Integration" />
                  </SelectTrigger>
                  <SelectContent>
                    {(integrations.data ?? []).map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="link-full-name">Provider repository</Label>
                <Select
                  value={externalFullName}
                  onValueChange={setExternalFullName}
                  disabled={!linkTarget.integrationId || externalRepos.isPending}
                >
                  <SelectTrigger className="w-64" id="link-full-name">
                    <SelectValue
                      placeholder={
                        !linkTarget.integrationId
                          ? "Select an integration first"
                          : externalRepos.isPending
                            ? "Loading repositories…"
                            : "Select a repository"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(externalRepos.data ?? []).map((r) => (
                      <SelectItem key={r.fullName} value={r.fullName} disabled={r.alreadyLinked}>
                        {r.fullName}
                        {r.isPrivate ? " · private" : ""}
                        {r.alreadyLinked ? " · already linked" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                size="sm"
                loading={link.isPending}
                disabled={!externalFullName || !linkTarget.repoId}
              >
                Link
              </Button>
            </form>
            {externalRepos.error && (
              <p className="text-destructive text-sm" role="alert">
                Could not list repositories: {externalRepos.error.message}
              </p>
            )}
            {externalRepos.isSuccess && externalRepos.data.length === 0 && (
              <p className="text-muted-foreground text-xs">
                This token cannot see any repositories. Check its scopes on the provider.
              </p>
            )}
            {link.error && (
              <p className="text-destructive text-sm" role="alert">
                {link.error.message}
              </p>
            )}
          </div>
        )}

        {(repos.data ?? []).filter((r) => r.integrationId).length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <p className="font-medium text-sm">Linked repositories</p>
            <ul className="space-y-2">
              {(repos.data ?? [])
                .filter((r) => r.integrationId)
                .map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3">
                    <Badge variant="secondary">
                      {r.name} · {r.externalFullName}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      loading={sync.isPending && sync.variables?.repositoryId === r.id}
                      onClick={() => sync.mutate({ repositoryId: r.id })}
                    >
                      <RefreshCw /> Sync now
                    </Button>
                  </li>
                ))}
            </ul>
            {sync.error && (
              <p className="text-destructive text-sm" role="alert">
                {sync.error.message}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
