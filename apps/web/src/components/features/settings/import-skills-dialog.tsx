"use client";

import {
  AgentLibraryErrorCode,
  type ScannedSkillDto,
  type SkillImportSource,
} from "@solow/contracts";
import { Download, FileArchive, FolderOpen, Search } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { trpc } from "@/trpc/react";

/**
 * Bulk import of Skills from a directory on this machine or a git repository (spec F24).
 *
 * Two steps on purpose: a scan first, which finds every directory holding a `SKILL.md` and
 * says what it would call each one, then the import of the ones left ticked. A directory of
 * fifty Skills usually has a few the team does not want every agent reading, and the only
 * moment to leave those out is before they are in the library. A Skill whose name is already
 * there is shown unticked and locked, with the reason, rather than silently dropped.
 *
 * Each import is a directory source: the scripts, references and assets beside the SKILL.md go
 * with it, and the directory is read again on every run — so a repository is cloned once into
 * SoloW's skills directory and pulled forward on the next scan, never re-cloned by hand.
 *
 * A `.zip` is the third way in: picked here, or dropped anywhere on the Skills card, which hands
 * it over as `droppedFile`. The archive is unpacked server-side into that same directory and
 * scanned like a folder, so the picker that follows is the one the other two sources get.
 */
type Source = SkillImportSource["kind"] | "zip";

/** A file's bytes as base64, in chunks: `String.fromCharCode(...bytes)` overflows the stack past ~100 KB. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function ImportSkillsDialog({
  trigger,
  onImported,
  droppedFile = null,
  onDroppedFileTaken,
}: {
  trigger: ReactNode;
  onImported: (count: number, skipped: number) => void;
  /** A `.zip` dropped on the surface around this dialog: opens it in zip mode and unpacks at once. */
  droppedFile?: File | null;
  onDroppedFileTaken?: () => void;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Source>("path");
  const [location, setLocation] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [found, setFound] = useState<ScannedSkillDto[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [overDropZone, setOverDropZone] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setLocation("");
    setArchive(null);
    setEnabled(false);
    setFound(null);
    setPicked(new Set());
  };

  const showFound = ({ skills }: { skills: ScannedSkillDto[] }) => {
    setFound(skills);
    setPicked(new Set(skills.filter((s) => !s.existing).map((s) => s.name)));
  };
  const scan = trpc.library.skill.scan.useMutation({ onSuccess: showFound });
  const unpack = trpc.library.skill.unpack.useMutation({ onSuccess: showFound });

  const takeArchive = async (file: File) => {
    setKind("zip");
    setArchive(file);
    setFound(null);
    unpack.mutate({ fileName: file.name, zipBase64: await fileToBase64(file) });
  };

  // A drop on the card lands here: open in zip mode and unpack straight away, since the drop
  // was the whole gesture — asking for a second click would be asking twice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the dropped file, by design
  useEffect(() => {
    if (!droppedFile) return;
    setOpen(true);
    void takeArchive(droppedFile);
    onDroppedFileTaken?.();
  }, [droppedFile]);
  const doImport = trpc.library.skill.import.useMutation({
    onSuccess: ({ imported, skipped }) => {
      utils.library.skill.list.invalidate();
      onImported(imported.length, skipped.length);
      setOpen(false);
      reset();
    },
  });

  const source: SkillImportSource | null =
    kind === "path"
      ? { kind, path: location.trim() }
      : kind === "git"
        ? { kind, url: location.trim() }
        : null;
  const pending = scan.isPending || unpack.isPending;
  const error = scan.error ?? unpack.error;
  const toggle = (name: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const chosen = (found ?? []).filter((s) => picked.has(s.name));

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
          <DialogTitle>Import skills</DialogTitle>
          <DialogDescription>
            Every directory holding a SKILL.md becomes one Skill, with the scripts and references
            beside it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <form
            className={`grid gap-3 ${kind === "zip" ? "sm:grid-cols-[13rem_1fr]" : "sm:grid-cols-[13rem_1fr_auto]"}`}
            onSubmit={(e) => {
              e.preventDefault();
              if (source) scan.mutate({ source });
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="skills-import-kind">From</Label>
              <Select
                value={kind}
                onValueChange={(v) => {
                  setKind(v as Source);
                  setFound(null);
                }}
              >
                <SelectTrigger id="skills-import-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="path">A directory on this machine</SelectItem>
                  <SelectItem value="git">A git repository</SelectItem>
                  <SelectItem value="zip">A .zip file</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {kind === "zip" ? (
              <div className="grid gap-2">
                <Label htmlFor="skills-import-file">Archive</Label>
                {/* The drop zone is also a button: keyboard and file picker for whoever is not
                    dragging. The input stays in the DOM, hidden, so a test and a browser reach
                    the same code path. */}
                <button
                  type="button"
                  className={`flex min-h-16 items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-sm transition-colors ${
                    overDropZone
                      ? "border-primary bg-primary/5 text-foreground"
                      : "text-muted-foreground hover:border-ring/40 hover:bg-accent/30"
                  }`}
                  onClick={() => fileInput.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverDropZone(true);
                  }}
                  onDragLeave={() => setOverDropZone(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOverDropZone(false);
                    const file = e.dataTransfer.files[0];
                    if (file) void takeArchive(file);
                  }}
                >
                  <FileArchive aria-hidden className="size-4 shrink-0" />
                  {archive ? (
                    <span className="truncate font-mono text-xs">{archive.name}</span>
                  ) : (
                    <span>Drop a .zip here, or click to choose one</span>
                  )}
                </button>
                <input
                  ref={fileInput}
                  id="skills-import-file"
                  type="file"
                  accept=".zip,application/zip,application/x-zip-compressed"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void takeArchive(file);
                    e.target.value = "";
                  }}
                />
              </div>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="skills-import-location">
                    {kind === "path" ? "Directory" : "Repository URL"}
                  </Label>
                  <Input
                    id="skills-import-location"
                    className="font-mono"
                    placeholder={
                      kind === "path" ? "/srv/skills" : "https://github.com/acme/skills.git"
                    }
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <span className="text-sm opacity-0" aria-hidden>
                    Scan
                  </span>
                  <Button type="submit" variant="secondary" loading={pending}>
                    <Search aria-hidden />
                    Scan
                  </Button>
                </div>
              </>
            )}
          </form>
          {kind === "zip" && unpack.isPending && (
            <p className="text-muted-foreground text-sm" role="status">
              Unpacking {archive?.name ?? "the archive"}…
            </p>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {describeScanError(error.message, kind)}
            </p>
          )}

          {found && found.length === 0 && (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
              No SKILL.md found under there.
            </p>
          )}
          {found && found.length > 0 && (
            <ul className="divide-y rounded-lg border" aria-label="Skills found">
              {found.map((s) => (
                <li key={s.name} className="flex items-start gap-3 px-3 py-2.5">
                  <Checkbox
                    className="mt-0.5"
                    aria-label={`Import ${s.name}`}
                    checked={picked.has(s.name)}
                    disabled={s.existing}
                    onCheckedChange={(checked) => toggle(s.name, checked === true)}
                  />
                  <span
                    className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded border bg-muted/40 text-muted-foreground"
                    aria-hidden
                  >
                    <FolderOpen className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium font-mono text-sm">{s.name}</span>
                      <Badge variant="outline" className="text-2xs">
                        {s.files} file{s.files === 1 ? "" : "s"}
                      </Badge>
                      {s.existing && (
                        <Badge variant="secondary" className="text-2xs">
                          already in the library
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs">{s.description}</p>
                    <p className="truncate font-mono text-2xs text-muted-foreground/80">
                      {s.relativePath}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {doImport.error && (
            <p className="text-destructive text-sm" role="alert">
              {doImport.error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              id="skills-import-enabled"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked === true)}
            />
            <Label htmlFor="skills-import-enabled">Load in every agent</Label>
          </div>
          <Button
            type="button"
            disabled={chosen.length === 0}
            loading={doImport.isPending}
            onClick={() =>
              doImport.mutate({
                skills: chosen.map(({ name, description, path }) => ({ name, description, path })),
                enabled,
              })
            }
          >
            <Download aria-hidden />
            Import {chosen.length} skill{chosen.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The scan's failure, said the way the operator can act on it. */
function describeScanError(code: string, kind: Source): string {
  if (code === AgentLibraryErrorCode.ImportSourceNotFound) {
    return "That is not a directory on the machine SoloW runs on.";
  }
  if (code === AgentLibraryErrorCode.ImportArchiveInvalid) {
    return "That is not a .zip SoloW can unpack — or it names a path outside itself, which is refused whole.";
  }
  if (code === AgentLibraryErrorCode.ImportCloneFailed) {
    return kind === "git"
      ? "That repository could not be cloned — check the URL, and that this machine can reach it without a password prompt."
      : code;
  }
  return code;
}
