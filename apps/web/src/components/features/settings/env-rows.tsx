"use client";

import { GUARDED_ENV_VARS, isGuardedEnvVar } from "@solow/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { newRowId } from "@/lib/row-id";

/**
 * Key/value repeater for a profile's runtime environment (issue #73).
 *
 * Held as an ordered pair list rather than as the record it serialises to, because a record
 * cannot represent a half-typed row: an empty key would collapse every unnamed row onto one
 * entry as the user types. Pairs are folded into the record on the way out.
 */
export type EnvPair = { id: string; key: string; value: string };

/**
 * The id is what React keys on. An array index would do until a row is removed, at which point
 * every row below it inherits a neighbour's key — and with it that neighbour's focus and cursor.
 */
export const newEnvPair = (): EnvPair => ({ id: newRowId(), key: "", value: "" });

export const toEnvPairs = (env: Record<string, string> | undefined): EnvPair[] =>
  Object.entries(env ?? {}).map(([key, value]) => ({ id: newRowId(), key, value }));

export const fromEnvPairs = (pairs: EnvPair[]): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const { key, value } of pairs) if (key.trim()) env[key.trim()] = value;
  return env;
};

export function EnvRows({
  pairs,
  onChange,
}: {
  pairs: EnvPair[];
  onChange: (next: EnvPair[]) => void;
}) {
  // Fully controlled: the parent owns the list. A local copy would go stale the moment the
  // parent loaded a different profile into the form.
  const rows = pairs;
  const update = onChange;

  return (
    <div className="grid gap-2">
      <Label>Environment</Label>
      <p className="text-muted-foreground text-xs">
        Variables for the runtime. {GUARDED_ENV_VARS.join(" and ")} belong to the billing guard and
        are rejected here.
      </p>
      {rows.map((row, i) => {
        const guarded = isGuardedEnvVar(row.key.trim());
        return (
          <div className="flex items-start gap-2" key={row.id}>
            <div className="grid flex-1 gap-1">
              <Input
                aria-invalid={guarded}
                aria-label="Variable name"
                onChange={(e) =>
                  update(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
                }
                placeholder="NAME"
                value={row.key}
              />
              {guarded && (
                <p className="text-destructive text-xs" role="alert">
                  {row.key.trim()} is shaped by the billing guard and cannot be set here.
                </p>
              )}
            </div>
            <Input
              aria-label="Variable value"
              className="flex-1"
              onChange={(e) =>
                update(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
              }
              placeholder="value"
              value={row.value}
            />
            <Button
              aria-label={`Remove ${row.key || "variable"}`}
              onClick={() => update(rows.filter((_, j) => j !== i))}
              type="button"
              variant="ghost"
            >
              Remove
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          onClick={() => update([...rows, newEnvPair()])}
          size="sm"
          type="button"
          variant="secondary"
        >
          Add variable
        </Button>
      </div>
    </div>
  );
}
