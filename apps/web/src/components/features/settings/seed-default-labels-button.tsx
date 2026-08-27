"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/trpc/react";

/**
 * Seeds a linked Repository's provider (GitHub/GitLab) with SoloW's own default label taxonomy
 * (`type/*`, `prio/*`, `size/*`, `status/*`, `area/*`) — additive only, safe to click more than
 * once. A purely local repository (`provider` null) has nothing to seed onto, so this renders
 * nothing for one.
 */
export function SeedDefaultLabelsButton({
  repositoryId,
  provider,
}: {
  repositoryId: string;
  provider: string | null;
}) {
  const [result, setResult] = useState<{ created: number; existing: number } | null>(null);

  const seed = trpc.repository.seedDefaultLabels.useMutation({
    onSuccess: (data) => {
      setResult({ created: data.created.length, existing: data.existing.length });
      // A label-seeding result is more informative than a bare "Saved" checkmark, so it stays
      // up longer than that idiom's usual 2s.
      setTimeout(() => setResult(null), 4000);
    },
  });

  if (provider === null) return null;

  return (
    <div className="flex items-center gap-2">
      <Button
        loading={seed.isPending}
        onClick={() => seed.mutate({ repositoryId })}
        size="sm"
        type="button"
        variant="outline"
      >
        Initialize default labels
      </Button>
      {result && (
        <span className="text-muted-foreground text-xs">
          {result.created} label{result.created === 1 ? "" : "s"} created, {result.existing} already
          there
        </span>
      )}
      {seed.error && (
        <p className="text-destructive text-xs" role="alert">
          {seed.error.message}
        </p>
      )}
    </div>
  );
}
