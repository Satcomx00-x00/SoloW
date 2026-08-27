"use client";

import type { McpScope } from "@solow/contracts";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/trpc/react";

/**
 * External MCP server (issue #16). Issue and revoke scoped tokens, and copy a ready-made client
 * configuration.
 *
 * The token value is rendered in exactly one place — the panel that appears immediately after
 * issuing — and that panel says so, because a value the UI cannot show again is the only honest
 * consequence of storing it hashed (AC-4).
 */

/**
 * The endpoint as a client must address it. The origin is only known in the browser, so it is
 * filled in after mount rather than during render — the server and the first client render must
 * agree on the relative path or React discards the tree as a hydration mismatch.
 */
function useEndpointUrl(): string {
  const [url, setUrl] = useState("/api/mcp");
  useEffect(() => setUrl(`${window.location.origin}/api/mcp`), []);
  return url;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * Per-client snippets (AC-6). `<token>` is a placeholder rather than the real value: these are
 * rendered from the token list too, long after the value is unrecoverable, and printing a live
 * credential into a config block the user may paste into a shared repo is worse than making them
 * substitute it themselves.
 */
function snippetsFor(url: string): { id: string; label: string; body: string }[] {
  const claudeCode = `claude mcp add --transport http solow ${url} \\
  --header "Authorization: Bearer <token>"`;

  const json = (key: string) =>
    JSON.stringify(
      { mcpServers: { solow: { [key]: url, headers: { Authorization: "Bearer <token>" } } } },
      null,
      2,
    );

  return [
    { id: "claude-code", label: "Claude Code", body: claudeCode },
    { id: "cursor", label: "Cursor", body: json("url") },
    { id: "codex", label: "Codex", body: json("url") },
  ];
}

export function McpSection() {
  const utils = trpc.useUtils();
  const tokens = trpc.mcpToken.list.useQuery({});
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<McpScope>("read");
  /** Held only in component state, only until the panel is dismissed. Never re-fetchable. */
  const [issued, setIssued] = useState<string | null>(null);

  const issue = trpc.mcpToken.issue.useMutation({
    onSuccess: (result) => {
      utils.mcpToken.list.invalidate();
      setIssued(result.value);
      setLabel("");
    },
  });
  const revoke = trpc.mcpToken.revoke.useMutation({
    onSuccess: () => utils.mcpToken.list.invalidate(),
  });

  const url = useEndpointUrl();
  const snippets = snippetsFor(url);
  const live = (tokens.data ?? []).filter((t) => !t.revokedAt);

  return (
    <Card id="mcp" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>MCP</CardTitle>
        <CardDescription>
          Drive SoloW from an outside agent. A token carries one Workspace and one scope — the same
          permission checks apply as in this UI.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-2">
          <Label htmlFor="mcp-endpoint">Endpoint</Label>
          <div className="flex items-center gap-2">
            <Input id="mcp-endpoint" readOnly value={url} className="font-mono text-xs" />
            <CopyButton text={url} label="Copy MCP endpoint URL" />
          </div>
        </div>

        <form
          className="space-y-4 border-t pt-6"
          onSubmit={(e) => {
            e.preventDefault();
            issue.mutate({ label, scope });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="mcp-label">Token label</Label>
            <Input
              id="mcp-label"
              placeholder="e.g. laptop-claude-code"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mcp-scope">Scope</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as McpScope)}>
              <SelectTrigger id="mcp-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Read only</SelectItem>
                <SelectItem value="read_write">Read and write</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" loading={issue.isPending}>
            Issue token
          </Button>
        </form>

        {issue.error && (
          <p className="text-destructive text-sm" role="alert">
            {issue.error.message}
          </p>
        )}

        {issued && (
          <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-4">
            <p className="font-medium text-sm">Copy this token now</p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              It is stored hashed, so this is the only time it can be shown. If you lose it, issue a
              new one and revoke this.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={issued} className="font-mono text-xs" />
              <CopyButton text={issued} label="Copy the issued token value" />
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        )}

        <div className="space-y-3 border-t pt-6">
          <p className="font-medium text-sm">Client configuration</p>
          <Tabs defaultValue="claude-code">
            <TabsList>
              {snippets.map((s) => (
                <TabsTrigger key={s.id} value={s.id}>
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {snippets.map((s) => (
              <TabsContent key={s.id} value={s.id} className="space-y-2">
                <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">
                  <code>{s.body}</code>
                </pre>
                <CopyButton text={s.body} label={`Copy the ${s.label} configuration`} />
              </TabsContent>
            ))}
          </Tabs>
        </div>

        {live.length > 0 && (
          <div className="space-y-2 border-t pt-6">
            <p className="font-medium text-sm">Issued tokens</p>
            <ul className="divide-y">
              {live.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{t.label}</p>
                    <p className="font-mono text-muted-foreground text-xs">{t.prefix}…</p>
                  </div>
                  <Badge variant="secondary">{t.scope === "read" ? "read" : "read/write"}</Badge>
                  <span className="text-muted-foreground text-xs">
                    {t.lastUsedAt ? `used ${t.lastUsedAt.slice(0, 10)}` : "never used"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    loading={revoke.isPending}
                    onClick={() => revoke.mutate({ id: t.id })}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
