"use client";

import type { RepositorySource } from "@gatecontrol/contracts";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/trpc/react";

/** Connect Repositories from a local clone path or a remote git URL. */
export function RepositoriesSection() {
  const utils = trpc.useUtils();
  const list = trpc.repository.list.useQuery({});
  const [name, setName] = useState("");
  const [source, setSource] = useState<RepositorySource>("local_path");
  const [location, setLocation] = useState("");

  const create = trpc.repository.connect.useMutation({
    onSuccess: () => {
      utils.repository.list.invalidate();
      setName("");
      setLocation("");
    },
  });

  return (
    <Card id="repositories" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Repositories</CardTitle>
        <CardDescription>A local clone path or a remote git URL.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name, source, location });
          }}
        >
          <Input
            aria-label="Repository name"
            placeholder="e.g. gate-firmware"
            className="max-w-40"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Select value={source} onValueChange={(v) => setSource(v as RepositorySource)}>
            <SelectTrigger aria-label="Repository source" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local_path">Local path</SelectItem>
              <SelectItem value="remote_url">Remote URL</SelectItem>
            </SelectContent>
          </Select>
          <Input
            aria-label="Repository location"
            placeholder={source === "local_path" ? "/srv/repos/…" : "https://github.com/…"}
            className="max-w-56"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            required
          />
          <Button type="submit" disabled={create.isPending}>
            Connect
          </Button>
        </form>
        {create.error && (
          <p className="text-destructive text-sm" role="alert">
            {create.error.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(list.data ?? []).map((r) => (
            <Badge key={r.id} variant="secondary">
              {r.name} · {r.source}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
