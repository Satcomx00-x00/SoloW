"use client";

import type { RepositorySource } from "@gatecontrol/contracts";
import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
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
 * A second, independent entry point to `repository.connect` — the same mutation Settings'
 * repositories-section.tsx already exposes, opened from the Board's Backlog instead. Not a
 * redirect: a user picking a Repository for a new Issue should not have to leave the board to
 * add one. The field shape mirrors Settings' form (name/source/location); Settings keeps its own
 * copy, per the instructions, rather than this importing from it.
 */
export function ConnectRepositoryDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  /** Omitted when the caller opens the dialog itself — the header's Create menu does. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [source, setSource] = useState<RepositorySource>("local_path");
  const [location, setLocation] = useState("");

  const connect = trpc.repository.connect.useMutation({
    onSuccess: () => {
      utils.repository.list.invalidate();
      setName("");
      setLocation("");
      setOpen(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Connect a repository</DialogTitle>
          <DialogDescription>A local clone path or a remote git URL.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate({ name, source, location });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="board-repo-name">Name</Label>
            <Input
              id="board-repo-name"
              placeholder="e.g. gate-firmware"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="board-repo-source">Source</Label>
            <Select value={source} onValueChange={(v) => setSource(v as RepositorySource)}>
              <SelectTrigger id="board-repo-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local_path">Local path</SelectItem>
                <SelectItem value="remote_url">Remote URL</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="board-repo-location">Location</Label>
            <Input
              id="board-repo-location"
              placeholder={
                source === "local_path" ? "/srv/repos/my-repo" : "https://github.com/org/repo.git"
              }
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              required
            />
          </div>
          {connect.error && (
            <p className="text-destructive text-sm" role="alert">
              {connect.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" loading={connect.isPending}>
              Connect repository
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
