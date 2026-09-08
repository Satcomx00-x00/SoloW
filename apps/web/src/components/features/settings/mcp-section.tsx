"use client";

import type { McpScope } from "@solow/contracts";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/trpc/react";
import {
  SectionStatus,
  SettingsCreate,
  SettingsEmpty,
  SettingsField,
  SettingsLoading,
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "./settings-shell";

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

/**
 * Copy, and say what actually happened.
 *
 * This used to fire the write and set "Copied" without waiting for it, which on this screen of
 * all screens is the wrong lie to tell: `navigator.clipboard` exists only in a secure context,
 * so it is missing over plain HTTP — and the whole point of these two buttons is to carry an
 * endpoint and a command line to *another machine*, which is exactly the case where the app is
 * reached over the network at `http://192.168.1.x:5000`. The button said "Copied", the clipboard
 * held whatever it held before, and the paste that followed was silently stale.
 *
 * It now reports the refusal instead. There is no fallback copy to offer — a page cannot write
 * the clipboard without the API — so the honest thing is to stop claiming and let the reader
 * select the text themselves, which they can: both are rendered as selectable text.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "refused">("idle");
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={async () => {
        try {
          // Not `?.` — an absent clipboard has to reach the `catch` rather than resolve to
          // undefined and be reported as a success, which is the bug this replaces.
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          // Refused, not broken: an insecure origin, or a permission the browser declined.
          setState("refused");
        }
        setTimeout(() => setState("idle"), 2500);
      }}
    >
      {state === "copied" ? <Check /> : <Copy />}
      {state === "copied" ? "Copied" : state === "refused" ? "Select it to copy" : "Copy"}
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
    <SettingsSection
      caption="Drive SoloW from an outside agent. A token carries one Workspace and one scope — the same permission checks apply as in this UI."
      id="mcp"
      status={
        tokens.isSuccess ? (
          <SectionStatus tone={live.length > 0 ? "active" : "idle"}>
            {live.length === 0
              ? "No live tokens"
              : `${live.length} live token${live.length === 1 ? "" : "s"}`}
          </SectionStatus>
        ) : null
      }
      title="MCP access"
    >
      <SettingsField htmlFor="mcp-endpoint" label="Endpoint">
        <div className="flex items-center gap-2">
          <Input className="font-mono text-xs" id="mcp-endpoint" readOnly value={url} />
          <CopyButton label="Copy MCP endpoint URL" text={url} />
        </div>
      </SettingsField>

      {/* The inventory, above the form that makes more of them — these are live credentials, and
          what already exists matters more than issuing another. */}
      {tokens.isPending ? (
        <SettingsLoading rows={2} />
      ) : live.length === 0 ? (
        <SettingsEmpty>No tokens issued. Nothing outside SoloW can reach it yet.</SettingsEmpty>
      ) : (
        <SettingsRows>
          {live.map((t) => (
            <SettingsRow
              actions={
                /*
                  Confirmed, at last. Revoking was one unconfirmed click while *deleting a Secret*
                  — which you can simply paste again — was confirmed, so the page asked hardest
                  about the cheaper mistake. A revoked token cannot be reinstated, and the thing
                  holding it is an outside agent that will fail mid-run without knowing why.
                */
                <ConfirmAction
                  confirmLabel="Revoke token"
                  description="Any outside agent using this token stops working immediately, mid-run if it is running. The token cannot be reinstated — you would issue a new one and reconfigure whatever held this."
                  onConfirm={() => revoke.mutate({ id: t.id })}
                  title={`Revoke "${t.label}"?`}
                  trigger={
                    <Button
                      aria-label={`Revoke the token ${t.label}`}
                      // Scoped by id. It used to bind the bare `isPending`, so revoking one token
                      // spun the button on every row — its siblings in this folder all scope by id.
                      loading={revoke.isPending && revoke.variables?.id === t.id}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Revoke
                    </Button>
                  }
                />
              }
              key={t.id}
              meta={
                <span className="font-mono">
                  {t.prefix}… · {t.scope === "read" ? "read only" : "read and write"}
                </span>
              }
              status={
                <SectionStatus tone={t.lastUsedAt ? "active" : "idle"}>
                  {t.lastUsedAt ? `used ${t.lastUsedAt.slice(0, 10)}` : "never used"}
                </SectionStatus>
              }
              title={t.label}
            />
          ))}
        </SettingsRows>
      )}

      {issued && (
        <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
          <p className="font-medium text-sm">Copy this token now</p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            It is stored hashed, so this is the only time it can be shown. If you lose it, issue a
            new one and revoke this.
          </p>
          <div className="flex items-center gap-2">
            <Input className="font-mono text-xs" readOnly value={issued} />
            <CopyButton label="Copy the issued token value" text={issued} />
          </div>
          <Button onClick={() => setIssued(null)} size="sm" type="button" variant="ghost">
            Done
          </Button>
        </div>
      )}

      <SettingsCreate defaultOpen={tokens.isSuccess && live.length === 0} label="Issue a token">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            issue.mutate({ label, scope });
          }}
        >
          <SettingsField htmlFor="mcp-label" label="Token label">
            <Input
              id="mcp-label"
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. laptop-claude-code"
              required
              value={label}
            />
          </SettingsField>
          <SettingsField htmlFor="mcp-scope" label="Scope">
            <Select onValueChange={(v) => setScope(v as McpScope)} value={scope}>
              <SelectTrigger className="w-full" id="mcp-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Read only</SelectItem>
                <SelectItem value="read_write">Read and write</SelectItem>
              </SelectContent>
            </Select>
          </SettingsField>
          <Button loading={issue.isPending} type="submit">
            Issue token
          </Button>
        </form>
        {issue.error && (
          <p className="text-destructive text-sm" role="alert">
            {issue.error.message}
          </p>
        )}
      </SettingsCreate>

      <div className="space-y-3 border-t pt-4">
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
            <TabsContent className="space-y-2" key={s.id} value={s.id}>
              <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs">
                <code>{s.body}</code>
              </pre>
              <CopyButton label={`Copy the ${s.label} configuration`} text={s.body} />
            </TabsContent>
          ))}
        </Tabs>
      </div>

      {revoke.error && (
        <p className="text-destructive text-sm" role="alert">
          {revoke.error.message}
        </p>
      )}
    </SettingsSection>
  );
}
