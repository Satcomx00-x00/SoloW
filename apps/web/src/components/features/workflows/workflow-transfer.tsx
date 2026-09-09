"use client";

import {
  type WorkflowDocument,
  type WorkflowWithStepsDto,
  workflowDocumentSchema,
} from "@solow/contracts";
import { workflowDocumentFilename } from "@solow/core";
import { Download, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";

/**
 * Sharing a pipeline: writing one out as a file, and reading one back in (`workflowDocumentSchema`).
 *
 * A file rather than a link or a copy-to-clipboard, because the thing being shared outlives the
 * conversation that shares it — a pipeline that works belongs beside the repository it runs on,
 * in review, in a gist. The format is JSON with names in it rather than ids, so the document is
 * also readable and editable by hand, which is what makes it worth checking in.
 *
 * The import is deliberately two-part: a *look* at what the file says before anything is written,
 * then a report of what could not be carried across. Both halves exist because the resolution is
 * lossy by design — see the format's own note — and an import that silently re-pointed four Steps
 * at the wrong harness is indistinguishable, in the designer, from one that matched everything.
 */

/** Hand the browser a file. Feature-detected, because a DOM stand-in in a test has neither half. */
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

export function ExportWorkflowButton({ workflow }: { workflow: WorkflowWithStepsDto }) {
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * `fetch` rather than a `useQuery`: the export is not something this panel displays, it is
   * something a click produces. A query would hold the whole document in the cache of every
   * Workflow ever looked at, and would have to be kept from running until the button was pressed.
   */
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const document = await utils.client.workflow.export.query({ id: workflow.id });
      saveJson(workflowDocumentFilename(workflow.name), `${JSON.stringify(document, null, 2)}\n`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={busy}
        onClick={() => void save()}
      >
        <Download aria-hidden />
        Export as JSON
      </Button>
      <p className="px-0.5 text-2xs text-muted-foreground leading-relaxed">
        Harnesses, servers and skills travel by name, so the file means the same thing in another
        workspace.
      </p>
      {error && (
        <p className="font-mono text-2xs text-state-failed" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The reason a file was rejected, said in one line the operator can act on. */
function readDocument(text: string): { document: WorkflowDocument } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: "That file is not JSON." };
  }
  const parsed = workflowDocumentSchema.safeParse(json);
  if (parsed.success) return { document: parsed.data };
  const first = parsed.error.issues[0];
  return {
    error: first?.path.length
      ? `Not a workflow document: ${first.path.join(".")} — ${first.message}.`
      : "Not a workflow document.",
  };
}

/** Case-insensitive, the same rule the server resolves names by. */
const key = (name: string) => name.trim().toLowerCase();

export function ImportWorkflowDialog({ trigger }: { trigger: ReactNode }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState<WorkflowDocument | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [fallback, setFallback] = useState<string>("");

  const profiles = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE }, { enabled: open });
  const known = new Set((profiles.data?.items ?? []).map((p) => key(p.name)));
  // Which harnesses this Workspace has nothing called — the same question the import will ask,
  // asked early so the fallback can be chosen rather than discovered afterwards.
  const unmatched = [
    ...new Set((doc?.steps ?? []).map((s) => s.harnessProfile).filter((n) => !known.has(key(n)))),
  ];

  const imported = trpc.workflow.import.useMutation({
    onSuccess: (result) => {
      utils.workflow.list.invalidate();
      // Nothing was substituted, so there is nothing to report: go straight to the pipeline.
      const clean =
        result.unmatchedHarnessProfiles.length === 0 &&
        result.unmatchedMcpServers.length === 0 &&
        result.unmatchedSkills.length === 0;
      if (clean) {
        setOpen(false);
        reset();
        router.push(`/workflows/${result.workflow.id}`);
      }
    },
  });

  const reset = () => {
    setDoc(null);
    setFileError(null);
    setName("");
    setFallback("");
    imported.reset();
  };

  const take = async (file: File) => {
    setFileError(null);
    const read = readDocument(await file.text());
    if ("error" in read) {
      setDoc(null);
      return setFileError(read.error);
    }
    setDoc(read.document);
    setName(read.document.name);
  };

  const report = imported.data;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Import a workflow</DialogTitle>
          <DialogDescription>
            A pipeline exported from any workspace. Its harnesses, MCP servers and skills are
            matched by name against this one.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {report ? (
            <div className="space-y-3 text-sm">
              <p>
                Imported <span className="font-medium">{report.workflow.name}</span> —{" "}
                {report.workflow.steps.length === 1
                  ? "1 step"
                  : `${report.workflow.steps.length} steps`}
                .
              </p>
              {(
                [
                  ["Harness profiles", report.unmatchedHarnessProfiles, "run on the fallback"],
                  ["MCP servers", report.unmatchedMcpServers, "dropped"],
                  ["Skills", report.unmatchedSkills, "dropped"],
                ] as const
              )
                .filter(([, names]) => names.length > 0)
                .map(([label, names, fate]) => (
                  <p key={label} className="text-muted-foreground text-xs leading-relaxed">
                    <span className="text-foreground">{label} not in this workspace</span> ({fate}):{" "}
                    <span className="font-mono">{names.join(", ")}</span>
                  </p>
                ))}
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="workflow-document">Workflow file</Label>
                <Input
                  id="workflow-document"
                  type="file"
                  accept=".json,application/json"
                  className="h-auto py-1.5 text-xs file:mr-2 file:text-xs"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void take(file);
                  }}
                />
                {fileError && (
                  <p className="text-2xs text-state-failed" role="alert">
                    {fileError}
                  </p>
                )}
              </div>

              {doc && (
                <>
                  <div className="grid gap-1.5">
                    <Label htmlFor="workflow-import-name">Name</Label>
                    <Input
                      id="workflow-import-name"
                      className="h-8 text-xs"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                    <p className="text-2xs text-muted-foreground">
                      Suffixed automatically if this workspace already has a pipeline by that name.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <span className="text-muted-foreground text-xs">
                      {doc.steps.length === 1 ? "1 step" : `${doc.steps.length} steps`}
                    </span>
                    <ol className="space-y-px">
                      {doc.steps.map((step, index) => (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: the document is immutable here and its order is the pipeline — position is a Step's only identity before it is a row
                          key={`${index}-${step.name}`}
                          className="flex items-baseline gap-2 rounded-md px-2 py-1 text-xs odd:bg-muted/40"
                        >
                          <span className="w-3 shrink-0 text-2xs text-muted-foreground tabular-nums">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{step.name}</span>
                          <span
                            className={`shrink-0 font-mono text-2xs ${known.has(key(step.harnessProfile)) ? "text-muted-foreground" : "text-state-failed"}`}
                          >
                            {step.harnessProfile}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>

                  {unmatched.length > 0 && (
                    <div className="grid gap-1.5">
                      <Label htmlFor="workflow-import-fallback">Harness for unmatched steps</Label>
                      <Select value={fallback} onValueChange={setFallback}>
                        <SelectTrigger id="workflow-import-fallback" className="h-8 w-full text-xs">
                          <SelectValue placeholder="First profile by name" />
                        </SelectTrigger>
                        <SelectContent>
                          {(profiles.data?.items ?? []).map((profile) => (
                            <SelectItem key={profile.id} value={profile.id}>
                              {profile.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-2xs text-muted-foreground leading-relaxed">
                        This workspace has no{" "}
                        <span className="font-mono">{unmatched.join(", ")}</span>. Those steps land
                        here, and can be re-pointed on the canvas.
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {imported.error && (
            <p className="font-mono text-2xs text-state-failed" role="alert">
              {imported.error.message}
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          {report ? (
            <Button
              type="button"
              onClick={() => {
                setOpen(false);
                const id = report.workflow.id;
                reset();
                router.push(`/workflows/${id}`);
              }}
            >
              Open pipeline
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!doc || imported.isPending}
              onClick={() => {
                if (!doc) return;
                imported.mutate({
                  document: doc,
                  ...(name.trim() && name.trim() !== doc.name ? { name: name.trim() } : {}),
                  ...(fallback ? { fallbackHarnessProfileId: fallback } : {}),
                });
              }}
            >
              <Upload aria-hidden />
              Import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
