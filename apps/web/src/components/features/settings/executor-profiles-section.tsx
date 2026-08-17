"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/trpc/react";

/** Create Executor Profiles (v1 supports the local kind only). */
export function ExecutorProfilesSection() {
  const utils = trpc.useUtils();
  const list = trpc.profile.executor.list.useQuery({});
  const [name, setName] = useState("");

  const create = trpc.profile.executor.create.useMutation({
    onSuccess: () => {
      utils.profile.executor.list.invalidate();
      setName("");
    },
  });

  return (
    <Card id="executor-profiles" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Executor profiles</CardTitle>
        <CardDescription>Where agents run. v1 supports the local kind.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name, kind: "local" });
          }}
        >
          <Input
            aria-label="Executor name"
            placeholder="e.g. Local executor"
            className="max-w-48"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Button type="submit" disabled={create.isPending}>
            Add executor
          </Button>
        </form>
        {create.error && (
          <p className="text-destructive text-sm" role="alert">
            {create.error.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(list.data ?? []).map((p) => (
            <Badge key={p.id} variant="secondary">
              {p.name} · {p.kind}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
