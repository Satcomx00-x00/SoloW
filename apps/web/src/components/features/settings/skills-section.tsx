"use client";

import type { SkillDto, SkillSource } from "@solow/contracts";
import { BookOpen, Download, FileArchive, FileText, FolderOpen, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/trpc/react";
import { ImportSkillsDialog } from "./import-skills-dialog";
import { LibraryEmpty, LibraryForm, LibraryQueryState, LibraryRow } from "./library-ui";
import { SectionStatus, SettingsLoading, SettingsSection } from "./settings-shell";

/**
 * The Skill library (spec F24): the playbooks a harness reads before it works.
 *
 * A Skill is either written here — the body *is* the `SKILL.md` SoloW writes for the harness at
 * launch — or kept in a directory on the host that already holds one, read fresh on every run.
 * *Every harness* is the Workspace-wide switch; a Skill left off is loaded only by the Workflow
 * Steps that name it.
 */
export function SkillsSection() {
  const utils = trpc.useUtils();
  const skills = trpc.library.skill.list.useQuery({});

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<SkillSource["kind"]>("inline");
  const [body, setBody] = useState("");
  const [path, setPath] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [imported, setImported] = useState<{ count: number; skipped: number } | null>(null);
  // A .zip dragged over the card: the overlay while it hovers, the file once it lands. Counted
  // rather than flagged because dragenter/dragleave fire for every child crossed on the way.
  const [dragDepth, setDragDepth] = useState(0);
  const [dropped, setDropped] = useState<File | null>(null);

  const refresh = () => utils.library.skill.list.invalidate();
  const create = trpc.library.skill.create.useMutation({
    onSuccess: () => {
      refresh();
      setAdding(false);
      setName("");
      setDescription("");
      setBody("");
      setPath("");
      setEnabled(false);
    },
  });
  const update = trpc.library.skill.update.useMutation({ onSuccess: refresh });
  const remove = trpc.library.skill.delete.useMutation({ onSuccess: refresh });

  const list: SkillDto[] = skills.data ?? [];
  const usable = !skills.error;
  const enabledCount = list.filter((skill) => skill.enabled).length;
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  return (
    // The drop target is a wrapper rather than the section itself: dragging a .zip anywhere over
    // this block should import it, and `SettingsSection` owns its own two-column grid.
    //
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop zone has no ARIA role of its own, and every import it offers is also reachable from the keyboard through the Import dialog beside it — this is an enhancement over that button, never the only route.
    <div
      className="relative"
      onDragEnter={(e) => {
        if (!usable || !hasFiles(e)) return;
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        if (!usable || !hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        setDragDepth((d) => Math.max(0, d - 1));
      }}
      onDrop={(e) => {
        if (!usable || !hasFiles(e)) return;
        e.preventDefault();
        setDragDepth(0);
        const file = Array.from(e.dataTransfer.files).find((f) => /\.zip$/i.test(f.name));
        if (file) setDropped(file);
      }}
    >
      {dragDepth > 0 && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-primary border-dashed bg-background/85 text-sm"
          role="status"
        >
          <FileArchive aria-hidden className="mr-2 size-4" />
          Drop the .zip to import the Skills in it
        </div>
      )}
      <SettingsSection
        caption="Playbooks a harness reads before it works — written here, or kept in a directory on this machine. Every harness loads an enabled one into every run; otherwise only the Workflow Steps that name it do."
        id="skills"
        status={
          skills.isSuccess ? (
            <SectionStatus tone={enabledCount > 0 ? "active" : "idle"}>
              {list.length === 0 ? "None yet" : `${enabledCount} of ${list.length} enabled`}
            </SectionStatus>
          ) : null
        }
        title="Skills"
      >
        {usable && !adding && (
          <div className="flex items-center gap-2">
            <ImportSkillsDialog
              onImported={(count, skipped) => setImported({ count, skipped })}
              droppedFile={dropped}
              onDroppedFileTaken={() => setDropped(null)}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  <Download aria-hidden />
                  Import
                </Button>
              }
            />
            <Button onClick={() => setAdding(true)} size="sm" type="button" variant="outline">
              <Plus aria-hidden />
              New skill
            </Button>
          </div>
        )}
        <LibraryQueryState error={skills.error} />
        {skills.isPending && <SettingsLoading rows={2} />}
        {imported && (
          <p className="text-feedback-ok text-sm" role="status">
            Imported {imported.count} skill{imported.count === 1 ? "" : "s"}
            {imported.skipped > 0 &&
              ` · ${imported.skipped} skipped (already here, or no SKILL.md any more)`}
            .
          </p>
        )}

        {usable && list.length > 0 && (
          <ul aria-label="Skills" className="-mx-1 divide-y">
            {list.map((skill) => (
              <LibraryRow
                key={skill.id}
                icon={skill.source.kind === "inline" ? FileText : FolderOpen}
                name={skill.name}
                flavour={skill.source.kind === "inline" ? "written here" : "directory"}
                description={skill.description}
                detail={skill.source.kind === "path" ? skill.source.path : null}
                enabled={skill.enabled}
                onEnabled={(on) => update.mutate({ id: skill.id, enabled: on })}
                removeTitle={`Remove "${skill.name}"?`}
                removeDescription="Harnesses stop reading it on their next run. Refused while a Workflow Step still names it."
                removeLabel="Remove skill"
                onRemove={() => remove.mutate({ id: skill.id })}
              />
            ))}
          </ul>
        )}
        {usable && skills.data?.length === 0 && !adding && (
          <LibraryEmpty
            icon={BookOpen}
            title="No skills yet"
            hint="Write a SKILL.md here, point at a directory that holds one, or import every Skill in a folder or repository — then switch them on for every harness or name them from a Workflow Step."
            action="New skill"
            onAdd={() => setAdding(true)}
            secondary={
              <ImportSkillsDialog
                onImported={(count, skipped) => setImported({ count, skipped })}
                trigger={
                  <Button type="button" variant="outline" size="sm">
                    <Download aria-hidden />
                    Import from a folder or repo
                  </Button>
                }
              />
            }
          />
        )}
        {(update.error || remove.error) && (
          <p className="font-mono text-feedback-error text-xs" role="alert">
            {(update.error ?? remove.error)?.message}
          </p>
        )}

        {usable && adding && (
          <LibraryForm
            title="New skill"
            onCancel={() => setAdding(false)}
            onSubmit={() =>
              create.mutate({
                name: name.trim(),
                description: description.trim(),
                source: kind === "inline" ? { kind, body } : { kind, path: path.trim() },
                enabled,
              })
            }
          >
            <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
              <div className="grid gap-2">
                <Label htmlFor="skill-name">Name</Label>
                <Input
                  id="skill-name"
                  placeholder="review-checklist"
                  className="font-mono"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="skill-kind">Source</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as SkillSource["kind"])}>
                  <SelectTrigger id="skill-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inline">Written here</SelectItem>
                    <SelectItem value="path">A directory on this machine</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="skill-description">Description</Label>
              <Input
                id="skill-description"
                placeholder="When a harness should reach for it"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>
            {kind === "inline" ? (
              <div className="grid gap-2">
                <Label htmlFor="skill-body">SKILL.md</Label>
                <Textarea
                  id="skill-body"
                  rows={10}
                  className="font-mono text-xs leading-relaxed"
                  placeholder={"# Review checklist\n\nBefore approving…"}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  required
                />
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="skill-path">Directory holding SKILL.md</Label>
                <Input
                  id="skill-path"
                  placeholder="/srv/skills/review-checklist"
                  className="font-mono"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  required
                />
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Read on every run, so a checkout of a skills repository stays current without a
                  copy. Files the SKILL.md references travel with it.
                </p>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 border-t pt-4">
              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  id="skill-enabled"
                  checked={enabled}
                  onCheckedChange={(checked) => setEnabled(checked === true)}
                />
                <Label htmlFor="skill-enabled">Load in every harness</Label>
              </div>
              <Button type="submit" loading={create.isPending}>
                Add skill
              </Button>
            </div>
            {create.error && (
              <p className="font-mono text-feedback-error text-xs" role="alert">
                {create.error.message}
              </p>
            )}
          </LibraryForm>
        )}
      </SettingsSection>
    </div>
  );
}
