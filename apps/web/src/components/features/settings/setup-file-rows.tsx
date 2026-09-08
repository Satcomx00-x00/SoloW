"use client";

import { MAX_SETUP_FILE_PATTERNS, setupFilePatternSchema } from "@solow/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { newRowId } from "@/lib/row-id";
import { trpc } from "@/trpc/react";

/**
 * Per-Repository allowlist of files copied into every new worktree (issue #52).
 *
 * A fresh worktree has no `.env`, so the harness cannot run the test suite or start the dev
 * server. This is where an operator names the handful of files that fixes that — and it is
 * deliberately a list of names, never a "copy everything git-ignored" switch.
 *
 * Because the feature moves secrets by design, the warning below is standing rather than
 * conditional: a reader deciding whether to add a pattern should see the consequence at the
 * moment they decide, not after saving.
 */

/** One editable row. The id is what React keys on — see `env-rows.tsx` for why not the index. */
type PatternRow = { id: string; value: string };

const newRow = (value = ""): PatternRow => ({ id: newRowId(), value });

export function SetupFileRows({
  repositoryId,
  patterns,
}: {
  repositoryId: string;
  patterns: string[];
}) {
  const utils = trpc.useUtils();
  const [rows, setRows] = useState<PatternRow[]>(() => patterns.map((p) => newRow(p)));
  const [saved, setSaved] = useState(false);

  const save = trpc.repository.updateSetup.useMutation({
    onSuccess: () => {
      utils.repository.list.invalidate();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  // Empty rows are the half-typed state of a repeater, not a pattern meaning "everything".
  const filled = rows.map((r) => r.value.trim()).filter((v) => v.length > 0);
  const invalid = rows.map((r) => {
    const value = r.value.trim();
    if (value.length === 0) return null;
    const parsed = setupFilePatternSchema.safeParse(value);
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? "invalid pattern");
  });
  const canSave = invalid.every((m) => m === null) && filled.length <= MAX_SETUP_FILE_PATTERNS;

  return (
    <div className="grid gap-2">
      {/*
        The standing warning that used to live here now sits once at the top of the section.
        It is a fact about *every* pattern on the page, not about this repository — and printed
        per repository it appeared seven times in one card, which is how a warning stops being
        read. See `SETUP_FILE_WARNING` in repositories-section.tsx.
      */}
      <p className="text-muted-foreground text-xs">
        Files copied from this repository into every new worktree, so the harness can run the tests
        and start the dev server. One glob per row, relative to the repository root.
      </p>
      {rows.map((row, i) => (
        <div className="grid gap-1" key={row.id}>
          <div className="flex items-center gap-2">
            <Input
              aria-invalid={invalid[i] !== null}
              aria-label="File pattern"
              className="flex-1"
              onChange={(e) =>
                setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
              }
              placeholder=".env"
              value={row.value}
            />
            <Button
              aria-label={`Remove ${row.value.trim() || "pattern"}`}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
              type="button"
              variant="ghost"
            >
              Remove
            </Button>
          </div>
          {invalid[i] && (
            <p className="text-destructive text-xs" role="alert">
              {invalid[i]}
            </p>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          disabled={rows.length >= MAX_SETUP_FILE_PATTERNS}
          onClick={() => setRows([...rows, newRow()])}
          size="sm"
          type="button"
          variant="secondary"
        >
          Add pattern
        </Button>
        <Button
          disabled={!canSave}
          loading={save.isPending}
          onClick={() => save.mutate({ repositoryId, setupFilePatterns: filled })}
          size="sm"
          type="button"
        >
          Save setup files
        </Button>
        {saved && <span className="text-muted-foreground text-xs">Saved</span>}
      </div>
      {save.error && (
        <p className="text-destructive text-xs" role="alert">
          {save.error.message}
        </p>
      )}
    </div>
  );
}
