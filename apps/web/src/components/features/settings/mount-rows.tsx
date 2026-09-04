"use client";

import type { ExecutorConfig } from "@solow/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { newRowId } from "@/lib/row-id";

/**
 * Bind-mount repeater for a Docker Executor Profile (issue #96, spec F07).
 *
 * `mounts` has been in the contract since #73 and was unreachable from Settings until now: a
 * Docker profile made here could name an image and nothing else, so the one thing an operator
 * most often needs from a container — a shared package cache, a read-only credential directory —
 * could only be set by writing the JSON column by hand.
 *
 * A sibling of `env-rows.tsx` rather than an inline block, and shaped exactly like it: an ordered
 * list carrying its own row ids, because the array it serialises to cannot represent a
 * half-typed row, and an index key would hand a removed row's focus and cursor to the row below.
 */
export type MountRow = { id: string; source: string; target: string; readOnly: boolean };

type DockerMount = Extract<ExecutorConfig, { kind: "docker" }>["mounts"][number];

export const newMountRow = (): MountRow => ({
  id: newRowId(),
  source: "",
  target: "",
  readOnly: false,
});

export const toMountRows = (mounts: readonly DockerMount[] | undefined): MountRow[] =>
  (mounts ?? []).map((mount) => ({ id: newRowId(), ...mount }));

/**
 * A row is kept only once it names both ends.
 *
 * The contract requires a non-empty source and an absolute target, so a row still being typed
 * would fail the whole save rather than the field — the same "an empty key is not a variable"
 * rule `fromEnvPairs` applies, for the same reason.
 */
export const fromMountRows = (rows: readonly MountRow[]): DockerMount[] =>
  rows
    .filter((row) => row.source.trim() && row.target.trim())
    .map((row) => ({
      source: row.source.trim(),
      target: row.target.trim(),
      readOnly: row.readOnly,
    }));

export function MountRows({
  rows,
  onChange,
}: {
  rows: MountRow[];
  onChange: (next: MountRow[]) => void;
}) {
  // Fully controlled, like `EnvRows`: the parent owns the list, and a local copy would go stale
  // the moment a different profile was loaded into the form.
  const update = onChange;

  return (
    <div className="grid gap-2">
      <Label>Mounts</Label>
      <p className="text-muted-foreground text-xs">
        Host directories the container can see. The target must be an absolute path inside the
        container; the Task&apos;s own worktrees and repositories are mounted for you.
      </p>
      {rows.map((row, i) => (
        <div className="flex items-center gap-2" key={row.id}>
          <Input
            aria-label="Mount source on the host"
            className="flex-1"
            onChange={(e) =>
              update(rows.map((r, j) => (j === i ? { ...r, source: e.target.value } : r)))
            }
            placeholder="/var/cache/bun"
            value={row.source}
          />
          <Input
            aria-label="Mount target in the container"
            className="flex-1"
            onChange={(e) =>
              update(rows.map((r, j) => (j === i ? { ...r, target: e.target.value } : r)))
            }
            placeholder="/root/.bun/install/cache"
            value={row.target}
          />
          <Label className="flex items-center gap-2 text-xs whitespace-nowrap">
            <Checkbox
              aria-label={`Mount ${row.source || "source"} read-only`}
              checked={row.readOnly}
              onCheckedChange={(checked) =>
                update(rows.map((r, j) => (j === i ? { ...r, readOnly: checked === true } : r)))
              }
            />
            Read-only
          </Label>
          <Button
            aria-label={`Remove mount ${row.source || "row"}`}
            onClick={() => update(rows.filter((_, j) => j !== i))}
            type="button"
            variant="ghost"
          >
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button
          onClick={() => update([...rows, newMountRow()])}
          size="sm"
          type="button"
          variant="secondary"
        >
          Add mount
        </Button>
      </div>
    </div>
  );
}
