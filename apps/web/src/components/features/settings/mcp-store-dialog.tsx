"use client";

import { HarnessLibraryErrorCode, type McpServerDto } from "@solow/contracts";
import {
  MCP_STORE,
  MCP_STORE_CATEGORIES,
  type McpStoreCategory,
  type McpStoreEntry,
  mcpStoreTransport,
} from "@solow/core";
import { Check, ExternalLink, KeyRound, Plug, Search, Store } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
 * The MCP store (spec F24): the well-known servers of `@solow/core`'s catalog, installed into
 * the library with a click. An entry that needs a credential opens a small form on its card —
 * a Secret picked from the ones the Workspace already holds, never a value typed here — and the
 * install writes an ordinary MCP server row the operator can then edit, switch on or remove.
 *
 * "Installed" is decided by name against the library as it is now: the same entry installed
 * twice would be two servers with one name, which the library refuses anyway.
 */
export function McpStoreDialog({
  trigger,
  installed,
  onInstalled,
}: {
  trigger: ReactNode;
  installed: readonly McpServerDto[];
  onInstalled: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<McpStoreCategory | "all">("all");
  const installedNames = useMemo(() => new Set(installed.map((s) => s.name)), [installed]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MCP_STORE.filter(
      (entry) =>
        (category === "all" || entry.category === category) &&
        (!q ||
          `${entry.title} ${entry.name} ${entry.description} ${entry.vendor}`
            .toLowerCase()
            .includes(q)),
    );
  }, [query, category]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>MCP store</DialogTitle>
          <DialogDescription>
            Well-known servers, one click each. A credential is picked from your Secrets, never
            typed here.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search
                aria-hidden
                className="-translate-y-1/2 absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
              />
              <Input
                aria-label="Search the store"
                placeholder="Search servers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-1">
              <CategoryChip active={category === "all"} onClick={() => setCategory("all")}>
                All
              </CategoryChip>
              {MCP_STORE_CATEGORIES.map((c) => (
                <CategoryChip
                  key={c.id}
                  active={category === c.id}
                  onClick={() => setCategory(c.id)}
                >
                  {c.label}
                </CategoryChip>
              ))}
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
              Nothing in the store matches.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2" aria-label="Store entries">
              {shown.map((entry) => (
                <StoreCard
                  key={entry.id}
                  entry={entry}
                  installed={installedNames.has(entry.name)}
                  onInstalled={onInstalled}
                />
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        active
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function StoreCard({
  entry,
  installed,
  onInstalled,
}: {
  entry: McpStoreEntry;
  installed: boolean;
  onInstalled: (name: string) => void;
}) {
  const utils = trpc.useUtils();
  const secrets = trpc.secret.list.useQuery({});
  const [configuring, setConfiguring] = useState(false);
  const [chosenSecrets, setChosenSecrets] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);

  const create = trpc.library.mcp.create.useMutation({
    onSuccess: (server) => {
      utils.library.mcp.list.invalidate();
      setConfiguring(false);
      onInstalled(server.name);
    },
  });

  const inputs = entry.transport.inputs;
  const install = () => {
    const built = mcpStoreTransport(entry, { secrets: chosenSecrets, settings });
    if (!built.ok) {
      setMissing(built.missing);
      setConfiguring(true);
      return;
    }
    setMissing([]);
    create.mutate({
      name: entry.name,
      description: entry.description,
      transport: built.transport,
      enabled: false,
    });
  };

  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-card/40 p-3">
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground"
          aria-hidden
        >
          <Plug className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-sm">{entry.title}</span>
            <Badge variant="outline" className="text-2xs uppercase">
              {entry.transport.kind === "stdio" ? "stdio" : "remote"}
            </Badge>
            {entry.local && (
              <Badge variant="secondary" className="text-2xs">
                no account needed
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-xs">{entry.description}</p>
          <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground/80">
            {entry.transport.kind === "stdio"
              ? [entry.transport.command, ...entry.transport.args].join(" ")
              : entry.transport.url}
          </p>
        </div>
      </div>

      {configuring && inputs.length > 0 && (
        <div className="grid gap-2 rounded-md border bg-background/40 p-2">
          {inputs.map((input) => {
            const id = `store-${entry.id}-${input.name}`;
            const invalid = missing.includes(input.name);
            return (
              <div key={input.name} className="grid gap-1">
                <Label htmlFor={id} className="text-xs">
                  {input.label}
                  {input.required ? "" : " (optional)"}
                </Label>
                {input.secret ? (
                  <Select
                    value={chosenSecrets[input.name] ?? ""}
                    onValueChange={(v) =>
                      setChosenSecrets((prev) => ({ ...prev, [input.name]: v }))
                    }
                  >
                    <SelectTrigger
                      id={id}
                      size="sm"
                      className="w-full text-xs"
                      aria-label={input.label}
                      aria-invalid={invalid}
                    >
                      <KeyRound aria-hidden className="size-3 text-muted-foreground" />
                      <SelectValue placeholder="Pick a secret" />
                    </SelectTrigger>
                    <SelectContent>
                      {(secrets.data ?? []).length === 0 && (
                        <p className="px-2 py-1.5 text-muted-foreground text-xs">
                          No Secrets yet — add one in Secrets above.
                        </p>
                      )}
                      {(secrets.data ?? []).map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={id}
                    className="h-7 font-mono text-xs"
                    placeholder={input.defaultValue ?? ""}
                    value={settings[input.name] ?? ""}
                    onChange={(e) =>
                      setSettings((prev) => ({ ...prev, [input.name]: e.target.value }))
                    }
                  />
                )}
                {input.hint && <p className="text-2xs text-muted-foreground">{input.hint}</p>}
                {invalid && (
                  <p className="text-2xs text-feedback-error" role="alert">
                    Pick a Secret for this.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {create.error && (
        <p className="text-feedback-error text-xs" role="alert">
          {create.error.message === HarnessLibraryErrorCode.NameTaken
            ? `A server named ${entry.name} is already in the library.`
            : create.error.message}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2">
        <a
          href={entry.homepage}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
        >
          {entry.vendor}
          <ExternalLink aria-hidden className="size-3" />
        </a>
        {installed ? (
          <span className="inline-flex items-center gap-1 text-feedback-ok text-xs">
            <Check aria-hidden className="size-3.5" />
            Installed
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant={configuring ? "default" : "outline"}
            loading={create.isPending}
            aria-label={`Install ${entry.title}`}
            onClick={() => {
              if (inputs.length > 0 && !configuring) {
                setConfiguring(true);
                return;
              }
              install();
            }}
          >
            {configuring ? "Install" : inputs.some((i) => i.required) ? "Set up" : "Install"}
          </Button>
        )}
      </div>
    </li>
  );
}

export { Store as McpStoreIcon };
