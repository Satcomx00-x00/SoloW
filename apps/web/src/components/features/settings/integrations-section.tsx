"use client";

import type { ScmProvider } from "@solow/contracts";
import { RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { WHOLE_PAGE } from "@/lib/paged";
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
  const repos = trpc.repository.list.useQuery({ ...WHOLE_PAGE });
  const patSecrets = (secrets.data ?? []).filter((s) => s.kind === "scm_pat");

  /**
   * The providers this build has (F21). Asked of the server rather than compiled in, because a
   * build that ships a fourth driver must offer it here without the settings page being edited —
   * which is the whole claim the registry makes.
   */
  const providers = trpc.integration.providers.useQuery({});
  const manifests = providers.data ?? [];
  const [provider, setProvider] = useState<ScmProvider>("");
  // Whatever the server listed first, until someone chooses. Deriving rather than defaulting to
  // "github" in `useState`: a build without a GitHub driver would otherwise open on a provider it
  // does not have, and the form would submit an id nothing can connect.
  const selected = manifests.find((m) => m.id === provider) ?? manifests[0] ?? null;
  const [secretId, setSecretId] = useState("");
  /** Keyed by field, because a provider's connect form is whatever its manifest declares. */
  const [values, setValues] = useState<Record<string, string>>({});
  const setField = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  /** The non-secret fields the chosen provider asks for. The token is picked from Secrets. */
  const configFields = (selected?.fields ?? []).filter((f) => !f.secret);
  const missingRequired = configFields.some((f) => f.required && !values[f.key]?.trim());

  const connect = trpc.integration.connect.useMutation({
    onSuccess: () => {
      utils.integration.list.invalidate();
      setSecretId("");
      setValues({});
    },
  });

  const [importFrom, setImportFrom] = useState("");
  const [externalFullName, setExternalFullName] = useState("");

  /**
   * The repositories the selected Integration's token can actually see. Fetched only once an
   * Integration is chosen, because the query authenticates against that Integration's stored
   * token — there is nothing meaningful to list before then.
   */
  const externalRepos = trpc.integration.listExternalRepositories.useQuery(
    { integrationId: importFrom },
    { enabled: importFrom.length > 0 },
  );

  /**
   * Switching Integration must drop the chosen repository: a full name is only meaningful on the
   * Integration that listed it, and carrying it across would submit a name from account A against
   * account B — the exact mistake the picker exists to prevent.
   */
  const changeIntegration = (integrationId: string) => {
    setImportFrom(integrationId);
    setExternalFullName("");
  };

  const importRepository = trpc.integration.importRepository.useMutation({
    onSuccess: () => {
      utils.repository.list.invalidate();
      utils.integration.listExternalRepositories.invalidate();
      setExternalFullName("");
    },
  });

  const sync = trpc.integration.syncRepositorySignals.useMutation();

  /**
   * Disconnecting invalidates the repository list too: the server unlinks every Repository that
   * pointed at this Integration, so a list still showing them linked would be stale in the one
   * place the user is looking.
   */
  const disconnect = trpc.integration.delete.useMutation({
    onSuccess: () => {
      utils.integration.list.invalidate();
      utils.repository.list.invalidate();
      setImportFrom("");
      setExternalFullName("");
    },
  });

  /** What disconnecting *this* Integration would take with it, in the user's own data. */
  const linkedTo = (integrationId: string) =>
    (repos.data?.items ?? []).filter((r) => r.integrationId === integrationId);

  return (
    <Card id="integrations" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
        <CardDescription>
          Connect a provider with a personal access token, then link a repository to import its
          Issues and sync its branches and change requests.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!selected) return;
            connect.mutate({
              provider: selected.id,
              secretId,
              ...(values.baseUrl?.trim() ? { baseUrl: values.baseUrl.trim() } : {}),
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="integration-provider">Provider</Label>
              <Select value={selected?.id ?? ""} onValueChange={setProvider}>
                <SelectTrigger className="w-full" id="integration-provider">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  {manifests.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
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
          {/*
            The rest of the form is whatever this provider declares. It used to be one Base URL
            field with both hosts named in its placeholder, offered to every provider — including
            any that has no such concept, and useless to one that needs an account email beside
            its token. Now the field, its help and whether it is required all come from the
            manifest: Gitea's base URL is required because Gitea has no hosted instance to fall
            back to, and GitHub's is not.
          */}
          {configFields.map((field) => (
            <div className="grid gap-2" key={field.key}>
              <Label htmlFor={`integration-${field.key}`}>
                {field.label}
                {!field.required && <span className="ml-1 text-muted-foreground">(optional)</span>}
              </Label>
              <Input
                id={`integration-${field.key}`}
                placeholder={field.placeholder ?? ""}
                value={values[field.key] ?? ""}
                onChange={(e) => setField(field.key, e.target.value)}
              />
              {field.help && <p className="text-muted-foreground text-xs">{field.help}</p>}
            </div>
          ))}
          <Button
            type="submit"
            loading={connect.isPending}
            disabled={!secretId || !selected || missingRequired}
          >
            Connect
          </Button>
        </form>
        {connect.error && (
          <p className="text-destructive text-sm" role="alert">
            {connect.error.message}
          </p>
        )}

        {(integrations.data?.length ?? 0) > 0 && (
          <ul className="divide-y border-t">
            {(integrations.data ?? []).map((i) => {
              const linked = linkedTo(i.id);
              return (
                <li key={i.id} className="flex items-center gap-3 py-2">
                  <Badge variant="secondary">
                    {i.provider} · {i.baseUrl ?? "cloud"}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                    {linked.length === 0
                      ? "no linked repositories"
                      : `linked to ${linked.map((r) => r.name).join(", ")}`}
                  </span>
                  {/*
                    The description names the consequences in the order they matter: what is lost
                    for good, and what survives. "Disconnect" without that reads as reversible,
                    and for the synced branches and change requests it is not.
                  */}
                  <ConfirmAction
                    title={`Disconnect ${i.provider}?`}
                    description={`${
                      linked.length === 0
                        ? "No repositories are linked to it. "
                        : `${String(linked.length)} linked ${linked.length === 1 ? "repository" : "repositories"} (${linked
                            .map((r) => r.name)
                            .join(", ")}) will be unlinked. `
                    }The branches and change requests synced from it are removed — nothing can refresh them once the token is gone. Issues already imported are kept, along with their Tasks.`}
                    confirmLabel="Disconnect"
                    onConfirm={() => disconnect.mutate({ id: i.id })}
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Disconnect the ${i.provider} integration`}
                        loading={disconnect.isPending && disconnect.variables?.id === i.id}
                      >
                        <Trash2 /> Disconnect
                      </Button>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
        {disconnect.error && (
          <p className="text-destructive text-sm" role="alert">
            {disconnect.error.message}
          </p>
        )}

        {/*
          No local Repository to pick any more. Importing used to mean binding a Repository the
          user had already connected by path to a provider repo, which put "have a clone on disk"
          in front of the thing they actually wanted — working on a repository they can see on
          GitHub. Now the pick *is* the Repository: SoloW records the provider's clone URL,
          and the orchestrator clones it the first time a Task runs against it.
        */}
        {(integrations.data?.length ?? 0) > 0 && (
          <div className="space-y-3 border-t pt-4">
            <p className="font-medium text-sm">Import a repository</p>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!importFrom || !externalFullName) return;
                importRepository.mutate({ integrationId: importFrom, externalFullName });
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="import-integration">Integration</Label>
                <Select value={importFrom} onValueChange={changeIntegration}>
                  <SelectTrigger className="w-40" id="import-integration">
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
                <Label htmlFor="import-full-name">Repository</Label>
                <Select
                  value={externalFullName}
                  onValueChange={setExternalFullName}
                  disabled={!importFrom || externalRepos.isPending}
                >
                  <SelectTrigger className="w-64" id="import-full-name">
                    <SelectValue
                      placeholder={
                        !importFrom
                          ? "Select an integration first"
                          : externalRepos.isPending
                            ? "Loading repositories…"
                            : "Select a repository"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(externalRepos.data ?? []).map((r) => (
                      <SelectItem key={r.fullName} value={r.fullName} disabled={r.alreadyImported}>
                        {r.fullName}
                        {r.isPrivate ? " · private" : ""}
                        {r.alreadyImported ? " · already imported" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                size="sm"
                loading={importRepository.isPending}
                disabled={!externalFullName}
              >
                Import
              </Button>
            </form>
            <p className="text-muted-foreground text-xs">
              The repository is cloned when a Task first runs against it, using this
              integration&apos;s token — private repositories need nothing set up on the host.
            </p>
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
            {importRepository.error && (
              <p className="text-destructive text-sm" role="alert">
                {importRepository.error.message}
              </p>
            )}
          </div>
        )}

        {(repos.data?.items ?? []).filter((r) => r.integrationId).length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <p className="font-medium text-sm">Imported repositories</p>
            <ul className="space-y-2">
              {(repos.data?.items ?? [])
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
