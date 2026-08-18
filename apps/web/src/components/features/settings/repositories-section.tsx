"use client";

import type { RepositorySource } from "@gatecontrol/contracts";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
      <CardContent className="space-y-4">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name, source, location });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="repo-name">Name</Label>
              <Input
                id="repo-name"
                placeholder="e.g. gate-firmware"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="repo-source">Source</Label>
              <Select value={source} onValueChange={(v) => setSource(v as RepositorySource)}>
                <SelectTrigger id="repo-source" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local_path">Local path</SelectItem>
                  <SelectItem value="remote_url">Remote URL</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="repo-location">Location</Label>
            <Input
              id="repo-location"
              placeholder={
                source === "local_path" ? "/srv/repos/my-repo" : "https://github.com/org/repo.git"
              }
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Connecting…" : "Connect repository"}
          </Button>
        </form>
        {create.error && (
          <p className="text-destructive text-sm" role="alert">
            {create.error.message}
          </p>
        )}
        {(list.data?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {(list.data ?? []).map((r) => (
              <Badge key={r.id} variant="secondary">
                {r.name} · {r.source}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
