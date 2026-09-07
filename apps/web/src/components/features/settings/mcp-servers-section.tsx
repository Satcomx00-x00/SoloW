"use client";

import type { McpConfigValue, McpServerDto, McpServerTransport } from "@solow/contracts";
import { Globe, KeyRound, Plug, Plus, Store, Terminal, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { joinCommandLine, splitCommandLine } from "@/lib/command-line";
import { newRowId } from "@/lib/row-id";
import { trpc } from "@/trpc/react";
import { LibraryEmpty, LibraryForm, LibraryQueryState, LibraryRow } from "./library-ui";
import { McpStoreDialog } from "./mcp-store-dialog";

/**
 * The MCP server library (spec F24): what an agent can be handed to call, kept in one place.
 *
 * The list is the point of the page and the switch on each row is the point of the list: *Every
 * agent* is what makes a server part of every run in the Workspace; a server left off is loaded
 * only by the Workflow Steps that name it. The form adds one — a command the agent spawns, or an
 * endpoint it connects to — with each env variable or header either typed in or pointed at a
 * Secret, because a token pasted into a config is a token the API would then return to every
 * reader (Principle IV).
 */

/** One env variable or header while it is being edited: a literal, or a Secret by id. */
type ValueRow = {
  id: string;
  name: string;
  kind: "literal" | "secret";
  text: string;
  /** Written in front of the Secret at run time — `Bearer ` for an Authorization header. */
  prefix: string;
};
const newRow = (): ValueRow => ({
  id: newRowId(),
  name: "",
  kind: "literal",
  text: "",
  prefix: "",
});

function rowsToValues(rows: ValueRow[]): Record<string, McpConfigValue> {
  const out: Record<string, McpConfigValue> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    out[name] =
      row.kind === "secret"
        ? { kind: "secret", secretId: row.text, ...(row.prefix ? { prefix: row.prefix } : {}) }
        : { kind: "literal", value: row.text };
  }
  return out;
}

function ValueRows({
  label,
  noun,
  rows,
  onChange,
  secrets,
}: {
  label: string;
  noun: string;
  rows: ValueRow[];
  onChange: (rows: ValueRow[]) => void;
  secrets: readonly { id: string; name: string }[];
}) {
  const set = (id: string, patch: Partial<ValueRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <div>
          <Label>{label}</Label>
          <p className="text-2xs text-muted-foreground">
            A value typed here is stored as is; a Secret is decrypted for the run and never shown.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => onChange([...rows, newRow()])}
        >
          <Plus aria-hidden />
          Add {noun}
        </Button>
      </div>
      {rows.length > 0 && (
        <div className="grid gap-1.5 rounded-md border bg-background/40 p-2">
          <div className="grid grid-cols-[1fr_7rem_1fr_1.5rem] gap-2 px-1 text-2xs text-muted-foreground uppercase tracking-wide">
            <span>Name</span>
            <span>From</span>
            <span>Value</span>
            <span />
          </div>
          {rows.map((row) => (
            <div key={row.id} className="grid grid-cols-[1fr_7rem_1fr_1.5rem] items-center gap-2">
              <Input
                aria-label={`${label} name`}
                placeholder="NAME"
                className="h-7 font-mono text-xs"
                value={row.name}
                onChange={(e) => set(row.id, { name: e.target.value })}
              />
              <Select
                value={row.kind}
                onValueChange={(v) => set(row.id, { kind: v as ValueRow["kind"], text: "" })}
              >
                <SelectTrigger size="sm" className="text-xs" aria-label={`${label} value kind`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="literal">Typed here</SelectItem>
                  <SelectItem value="secret">A Secret</SelectItem>
                </SelectContent>
              </Select>
              {row.kind === "secret" ? (
                <div className="flex min-w-0 items-center gap-1">
                  {/* The scheme in front of the token — `Bearer ` for nearly every remote
                      endpoint — stays visible here while the token itself stays a Secret. */}
                  <Input
                    aria-label={`${label} prefix`}
                    placeholder="Bearer "
                    className="h-7 w-20 shrink-0 font-mono text-xs"
                    value={row.prefix}
                    onChange={(e) => set(row.id, { prefix: e.target.value })}
                  />
                  <Select value={row.text} onValueChange={(v) => set(row.id, { text: v })}>
                    <SelectTrigger
                      size="sm"
                      className="min-w-0 text-xs"
                      aria-label={`${label} secret`}
                    >
                      <KeyRound aria-hidden className="size-3 text-muted-foreground" />
                      <SelectValue placeholder="Pick a secret" />
                    </SelectTrigger>
                    <SelectContent>
                      {secrets.length === 0 && (
                        <p className="px-2 py-1.5 text-muted-foreground text-xs">
                          No Secrets yet — add one in Secrets above.
                        </p>
                      )}
                      {secrets.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <Input
                  aria-label={`${label} value`}
                  placeholder="value"
                  className="h-7 font-mono text-xs"
                  value={row.text}
                  onChange={(e) => set(row.id, { text: e.target.value })}
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${label.toLowerCase()} row`}
                onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One line that says what the agent will be told, without the values. */
function describeTransport(transport: McpServerTransport): string {
  if (transport.kind === "stdio") {
    const env = Object.keys(transport.env);
    return `${joinCommandLine(transport)}${env.length ? ` · env ${env.join(", ")}` : ""}`;
  }
  const headers = Object.keys(transport.headers);
  return `${transport.url}${headers.length ? ` · headers ${headers.join(", ")}` : ""}`;
}

export function McpServersSection() {
  const utils = trpc.useUtils();
  const servers = trpc.library.mcp.list.useQuery({});
  const secrets = trpc.secret.list.useQuery({});

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<McpServerTransport["kind"]>("stdio");
  const [commandLine, setCommandLine] = useState("");
  const [url, setUrl] = useState("");
  const [values, setValues] = useState<ValueRow[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [installed, setInstalled] = useState<string | null>(null);

  const refresh = () => utils.library.mcp.list.invalidate();
  const create = trpc.library.mcp.create.useMutation({
    onSuccess: () => {
      refresh();
      setAdding(false);
      setName("");
      setDescription("");
      setCommandLine("");
      setUrl("");
      setValues([]);
      setEnabled(false);
    },
  });
  const update = trpc.library.mcp.update.useMutation({ onSuccess: refresh });
  const remove = trpc.library.mcp.delete.useMutation({ onSuccess: refresh });

  // The command as one line, split the way a shell would (see lib/command-line.ts); a line that
  // does not split is the one thing the form refuses before the server sees it.
  const parsed = kind === "stdio" ? splitCommandLine(commandLine) : null;
  const commandError = parsed && "error" in parsed ? parsed.error : null;
  const transport = (): McpServerTransport | null => {
    if (kind === "http") return { kind, url: url.trim(), headers: rowsToValues(values) };
    if (!parsed || "error" in parsed) return null;
    return { kind, command: parsed.command, args: parsed.args, env: rowsToValues(values) };
  };

  const list: McpServerDto[] = servers.data ?? [];
  const secretOptions = (secrets.data ?? []).map((s) => ({ id: s.id, name: s.name }));
  const usable = !servers.error;

  return (
    <Card id="mcp-servers" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>MCP servers</CardTitle>
        <CardDescription>
          Tools an agent can call. <em>Every agent</em> loads one into every run; otherwise only the
          Workflow Steps that name it do.
        </CardDescription>
        {usable && !adding && (
          <CardAction className="flex items-center gap-2">
            <McpStoreDialog
              installed={list}
              onInstalled={(name) => setInstalled(name)}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  <Store aria-hidden />
                  Store
                </Button>
              }
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              New MCP server
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <LibraryQueryState error={servers.error} />
        {installed && (
          <p className="text-sm text-state-done" role="status">
            Installed <span className="font-mono">{installed}</span> from the store — switched off
            until you turn it on or a Step names it.
          </p>
        )}

        {usable && list.length > 0 && (
          <ul className="divide-y rounded-lg border" aria-label="MCP servers">
            {list.map((server) => (
              <LibraryRow
                key={server.id}
                icon={server.transport.kind === "stdio" ? Terminal : Globe}
                name={server.name}
                flavour={server.transport.kind}
                description={server.description}
                detail={describeTransport(server.transport)}
                enabled={server.enabled}
                onEnabled={(on) => update.mutate({ id: server.id, enabled: on })}
                removeTitle={`Remove "${server.name}"?`}
                removeDescription="Agents stop being handed it on their next run. Refused while a Workflow Step still names it."
                removeLabel="Remove server"
                onRemove={() => remove.mutate({ id: server.id })}
              />
            ))}
          </ul>
        )}
        {usable && servers.data?.length === 0 && !adding && (
          <LibraryEmpty
            icon={Plug}
            title="No MCP servers yet"
            hint="Install one from the store, or add a command the agent spawns or a URL it connects to — then switch it on for every agent or name it from a Workflow Step."
            action="New MCP server"
            onAdd={() => setAdding(true)}
            secondary={
              <McpStoreDialog
                installed={list}
                onInstalled={(name) => setInstalled(name)}
                trigger={
                  <Button type="button" variant="outline" size="sm">
                    <Store aria-hidden />
                    Browse the store
                  </Button>
                }
              />
            }
          />
        )}
        {(update.error || remove.error) && (
          <p className="font-mono text-state-failed text-xs" role="alert">
            {(update.error ?? remove.error)?.message}
          </p>
        )}

        {usable && adding && (
          <LibraryForm
            title="New MCP server"
            onCancel={() => setAdding(false)}
            onSubmit={() => {
              const built = transport();
              if (!built) return;
              create.mutate({
                name: name.trim(),
                ...(description.trim() ? { description: description.trim() } : {}),
                transport: built,
                enabled,
              });
            }}
          >
            <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
              <div className="grid gap-2">
                <Label htmlFor="mcp-name">Name</Label>
                <Input
                  id="mcp-name"
                  placeholder="github"
                  className="font-mono"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-kind">Transport</Label>
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    setKind(v as McpServerTransport["kind"]);
                    setValues([]);
                  }}
                >
                  <SelectTrigger id="mcp-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">Command (stdio)</SelectItem>
                    <SelectItem value="http">Remote URL (HTTP)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mcp-description">Description</Label>
              <Input
                id="mcp-description"
                placeholder="What it gives the agent"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {kind === "stdio" ? (
              <div className="grid gap-2">
                <Label htmlFor="mcp-command">Command</Label>
                <Input
                  id="mcp-command"
                  placeholder="npx -y @modelcontextprotocol/server-github"
                  className="font-mono"
                  value={commandLine}
                  aria-invalid={commandLine.trim() !== "" && commandError !== null}
                  aria-describedby="mcp-command-hint"
                  onChange={(e) => setCommandLine(e.target.value)}
                  required
                />
                <p id="mcp-command-hint" className="text-2xs text-muted-foreground">
                  {commandLine.trim() !== "" && commandError ? (
                    <span className="text-state-failed">{commandError}</span>
                  ) : parsed && !("error" in parsed) && parsed.args.length > 0 ? (
                    <>
                      Runs <span className="font-mono">{parsed.command}</span> with{" "}
                      {parsed.args.length} argument{parsed.args.length === 1 ? "" : "s"}:{" "}
                      <span className="font-mono">
                        {parsed.args.map((arg) => JSON.stringify(arg)).join(", ")}
                      </span>
                    </>
                  ) : (
                    "As you would type it in a shell — quote an argument that has a space in it."
                  )}
                </p>
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="mcp-url">URL</Label>
                <Input
                  id="mcp-url"
                  type="url"
                  placeholder="https://mcp.example.com/mcp"
                  className="font-mono"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  required
                />
                <p className="text-2xs text-muted-foreground">
                  A Streamable HTTP or SSE endpoint: a hosted server, or a gateway in front of many
                  — agentgateway's <span className="font-mono">/mcp</span>, for one. When it wants a
                  token, add an <span className="font-mono">Authorization</span> header from a
                  Secret with the <span className="font-mono">Bearer </span> prefix.
                </p>
              </div>
            )}
            <ValueRows
              label={kind === "stdio" ? "Environment" : "Headers"}
              noun={kind === "stdio" ? "variable" : "header"}
              rows={values}
              onChange={setValues}
              secrets={secretOptions}
            />
            <div className="flex items-center justify-between gap-3 border-t pt-4">
              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  id="mcp-enabled"
                  checked={enabled}
                  onCheckedChange={(checked) => setEnabled(checked === true)}
                />
                <Label htmlFor="mcp-enabled">Load in every agent</Label>
              </div>
              <Button type="submit" loading={create.isPending} disabled={commandError !== null}>
                Add MCP server
              </Button>
            </div>
            {create.error && (
              <p className="font-mono text-state-failed text-xs" role="alert">
                {create.error.message}
              </p>
            )}
          </LibraryForm>
        )}
      </CardContent>
    </Card>
  );
}
