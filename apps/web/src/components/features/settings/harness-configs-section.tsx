"use client";

import {
  HARNESS_CONFIG_TARGETS,
  type HarnessConfigDto,
  type HarnessConfigHarness,
  harnessConfigDocument,
  harnessConfigHarnessSchema,
  harnessConfigViolations,
} from "@solow/contracts";
import { Copy, Download, FileJson, Pencil, Trash2, Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/trpc/react";
import {
  SectionStatus,
  SettingsCreate,
  SettingsEmpty,
  SettingsLoading,
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "./settings-shell";

/**
 * Harness Configs (Decision 0028): the harness's own JSON — Claude Code's `settings.json`,
 * opencode's `opencode.json` — kept in SoloW rather than in the operator's home.
 *
 * A run never reads `~/.claude` or `~/.config/opencode` (Decision 0027); what it gets instead is
 * the config its Harness Profile selects from this list, handed over by flag or variable. So the
 * operator's own setup is never read and never modified, and a config here can be named, copied,
 * exported to a file and imported into another Workspace.
 */

const HARNESSES = harnessConfigHarnessSchema.options;
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Parse the editor's text into a config object, or say in one line why it is not one. */
export function parseConfigText(
  harness: HarnessConfigHarness,
  text: string,
): { content: Record<string, unknown> } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not valid JSON." };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { error: "The config must be a JSON object." };
  }
  const content = json as Record<string, unknown>;
  const violations = harnessConfigViolations(harness, content);
  return violations.length > 0 ? { error: violations.join("; ") } : { content };
}

/** Hand the browser a file — the same shape `workflow-transfer.tsx` uses for a pipeline. */
function saveJson(filename: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const fileNameFor = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "harness-config"
  }.solow.json`;

/** A JSON editor that validates as you type: syntax, object root, and the keys SoloW owns. */
function ConfigEditor({
  id,
  harness,
  value,
  onChange,
}: {
  id: string;
  harness: HarnessConfigHarness;
  value: string;
  onChange: (text: string) => void;
}) {
  const parsed = parseConfigText(harness, value);
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{HARNESS_CONFIG_TARGETS[harness].fileName}</Label>
        <Button
          disabled={"error" in parsed}
          onClick={() => "content" in parsed && onChange(pretty(parsed.content))}
          size="sm"
          type="button"
          variant="ghost"
        >
          Format
        </Button>
      </div>
      <Textarea
        aria-invalid={"error" in parsed}
        className="min-h-56 font-mono text-xs leading-relaxed"
        id={id}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        value={value}
      />
      {"error" in parsed ? (
        <p className="font-mono text-feedback-error text-xs" role="alert">
          {parsed.error}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Credentials belong in the profile's Secret, not here — a key in this file is refused.
        </p>
      )}
    </div>
  );
}

function EditConfig({ config, onDone }: { config: HarnessConfigDto; onDone: () => void }) {
  const utils = trpc.useUtils();
  const ids = useId();
  const [name, setName] = useState(config.name);
  const [description, setDescription] = useState(config.description ?? "");
  const [text, setText] = useState(pretty(config.content));
  const update = trpc.profile.harnessConfig.update.useMutation({
    onSuccess: () => {
      utils.profile.harnessConfig.list.invalidate();
      onDone();
    },
  });
  const parsed = parseConfigText(config.harness, text);

  return (
    <form
      className="mt-3 space-y-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!("content" in parsed)) return;
        update.mutate({
          id: config.id,
          harness: config.harness,
          name: name.trim(),
          description: description.trim() || null,
          content: parsed.content,
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-name`}>Name</Label>
          <Input
            id={`${ids}-name`}
            onChange={(e) => setName(e.target.value)}
            required
            value={name}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-description`}>Description</Label>
          <Input
            id={`${ids}-description`}
            onChange={(e) => setDescription(e.target.value)}
            value={description}
          />
        </div>
      </div>
      <ConfigEditor harness={config.harness} id={`${ids}-json`} onChange={setText} value={text} />
      {update.error && (
        <p className="text-destructive text-sm" role="alert">
          {update.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={"error" in parsed} loading={update.isPending} size="sm" type="submit">
          Save
        </Button>
      </div>
    </form>
  );
}

function ImportConfigButton({ onImported }: { onImported: (name: string) => void }) {
  const utils = trpc.useUtils();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const importConfig = trpc.profile.harnessConfig.import.useMutation({
    onSuccess: (row) => {
      utils.profile.harnessConfig.list.invalidate();
      onImported(row.name);
    },
    onError: (e) => setError(e.message),
  });

  const read = async (file: File) => {
    setError(null);
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      setError("That file is not JSON.");
      return;
    }
    const parsed = harnessConfigDocument.safeParse(json);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }
    importConfig.mutate({ document: parsed.data });
  };

  return (
    <>
      <input
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void read(file);
        }}
        ref={input}
        type="file"
      />
      <Button
        loading={importConfig.isPending}
        onClick={() => input.current?.click()}
        size="sm"
        type="button"
        variant="outline"
      >
        <Upload aria-hidden />
        Import
      </Button>
      {error && (
        <p className="basis-full font-mono text-feedback-error text-xs" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function HarnessConfigsSection() {
  const utils = trpc.useUtils();
  const configs = trpc.profile.harnessConfig.list.useQuery({});
  const ids = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [harness, setHarness] = useState<HarnessConfigHarness>("claude_code");
  const [text, setText] = useState(pretty(HARNESS_CONFIG_TARGETS.claude_code.template));

  const refresh = () => utils.profile.harnessConfig.list.invalidate();
  const create = trpc.profile.harnessConfig.create.useMutation({
    onSuccess: (row) => {
      refresh();
      setNotice(`Created "${row.name}".`);
      setName("");
      setDescription("");
      setText(pretty(HARNESS_CONFIG_TARGETS[harness].template));
    },
  });
  const duplicate = trpc.profile.harnessConfig.duplicate.useMutation({
    onSuccess: (row) => {
      refresh();
      setNotice(`Duplicated as "${row.name}".`);
    },
  });
  const remove = trpc.profile.harnessConfig.delete.useMutation({ onSuccess: refresh });
  const [exportError, setExportError] = useState<string | null>(null);

  const exportConfig = async (config: HarnessConfigDto) => {
    setExportError(null);
    try {
      const document = await utils.client.profile.harnessConfig.export.query({ id: config.id });
      saveJson(fileNameFor(config.name), pretty(document));
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  };

  const rows = configs.data ?? [];
  const parsed = parseConfigText(harness, text);
  const actionError = duplicate.error ?? remove.error;

  return (
    <SettingsSection
      caption="The harness's own settings — Claude Code's settings.json, opencode's opencode.json — kept here instead of in your home directory. A profile launches with the one it selects; your machine's own configuration is never read or changed."
      id="harness-configs"
      status={
        configs.isSuccess ? (
          <SectionStatus tone="idle">
            {rows.length === 0 ? "None yet" : `${rows.length} stored`}
          </SectionStatus>
        ) : null
      }
      title="Harness configs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ImportConfigButton onImported={(n) => setNotice(`Imported "${n}".`)} />
      </div>
      {notice && (
        <p className="text-feedback-ok text-sm" role="status">
          {notice}
        </p>
      )}
      {configs.isPending ? (
        <SettingsLoading rows={2} />
      ) : rows.length === 0 ? (
        <SettingsEmpty>
          No harness configs yet. Without one, a harness runs on its own defaults.
        </SettingsEmpty>
      ) : (
        <SettingsRows>
          {rows.map((config) => {
            const target = HARNESS_CONFIG_TARGETS[config.harness];
            const inUse = config.profileCount > 0;
            return (
              <SettingsRow
                actions={
                  <>
                    <Button
                      aria-label={`Edit the harness config ${config.name}`}
                      onClick={() => setEditing(editing === config.id ? null : config.id)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Pencil />
                    </Button>
                    <Button
                      aria-label={`Duplicate the harness config ${config.name}`}
                      loading={duplicate.isPending && duplicate.variables?.id === config.id}
                      onClick={() => duplicate.mutate({ id: config.id })}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Copy />
                    </Button>
                    <Button
                      aria-label={`Export the harness config ${config.name}`}
                      onClick={() => void exportConfig(config)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Download />
                    </Button>
                    <span
                      className="inline-flex"
                      title={
                        inUse ? "Selected by a harness profile. Change those first." : undefined
                      }
                    >
                      <ConfirmAction
                        confirmLabel="Delete config"
                        description="This cannot be undone. Export it first to keep a copy."
                        disabled={inUse}
                        onConfirm={() => remove.mutate({ id: config.id })}
                        title={`Delete "${config.name}"?`}
                        trigger={
                          <Button
                            aria-label={`Delete the harness config ${config.name}`}
                            disabled={inUse}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 />
                          </Button>
                        }
                      />
                    </span>
                  </>
                }
                key={config.id}
                meta={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="inline-flex items-center gap-1">
                      <FileJson aria-hidden className="size-3" />
                      {target.label} · {target.fileName}
                    </span>
                    {config.description && <span className="truncate">{config.description}</span>}
                  </span>
                }
                status={
                  <SectionStatus tone={inUse ? "active" : "idle"}>
                    {inUse
                      ? `${config.profileCount} profile${config.profileCount === 1 ? "" : "s"}`
                      : "Unused"}
                  </SectionStatus>
                }
                title={config.name}
              >
                {editing === config.id && (
                  <EditConfig config={config} onDone={() => setEditing(null)} />
                )}
              </SettingsRow>
            );
          })}
        </SettingsRows>
      )}
      {(actionError || exportError) && (
        <p className="text-destructive text-sm" role="alert">
          {actionError?.message ?? exportError}
        </p>
      )}

      <SettingsCreate defaultOpen={false} label="Add a harness config">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!("content" in parsed)) return;
            create.mutate({
              name: name.trim(),
              harness,
              content: parsed.content,
              ...(description.trim() ? { description: description.trim() } : {}),
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
            <div className="grid gap-2">
              <Label htmlFor={`${ids}-name`}>Name</Label>
              <Input
                id={`${ids}-name`}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Strict reviewer"
                required
                value={name}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${ids}-harness`}>Harness</Label>
              <Select
                onValueChange={(v) => {
                  const next = v as HarnessConfigHarness;
                  setHarness(next);
                  setText(pretty(HARNESS_CONFIG_TARGETS[next].template));
                }}
                value={harness}
              >
                <SelectTrigger className="w-full" id={`${ids}-harness`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HARNESSES.map((h) => (
                    <SelectItem key={h} value={h}>
                      {HARNESS_CONFIG_TARGETS[h].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${ids}-description`}>Description</Label>
            <Input
              id={`${ids}-description`}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What a profile gets by selecting it"
              value={description}
            />
          </div>
          <ConfigEditor harness={harness} id={`${ids}-json`} onChange={setText} value={text} />
          <Button
            disabled={"error" in parsed || !name.trim()}
            loading={create.isPending}
            type="submit"
          >
            Add config
          </Button>
          {create.error && (
            <p className="text-destructive text-sm" role="alert">
              {create.error.message}
            </p>
          )}
        </form>
      </SettingsCreate>
    </SettingsSection>
  );
}

const NONE = "__none__";

/**
 * Which Harness Config a profile launches with — only configs written for its harness are offered,
 * and a harness SoloW cannot hand a config to says so instead of offering nothing.
 */
export function HarnessConfigSelect({
  id,
  harness,
  value,
  onChange,
  label,
  className,
}: {
  id?: string;
  harness: HarnessConfigHarness | null;
  value: string | null;
  onChange: (id: string | null) => void;
  label?: string;
  className?: string;
}) {
  const configs = trpc.profile.harnessConfig.list.useQuery(harness ? { harness } : {}, {
    enabled: harness !== null,
  });
  const options = configs.data ?? [];
  return (
    <Select
      disabled={harness === null}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      value={value ?? NONE}
    >
      <SelectTrigger aria-label={label} className={className ?? "w-full"} id={id} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          {harness === null ? "Not configurable" : "Harness defaults"}
        </SelectItem>
        {options.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
