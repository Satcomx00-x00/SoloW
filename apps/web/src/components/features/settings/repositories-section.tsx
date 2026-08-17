"use client";

import type { RepositorySource } from "@gatecontrol/contracts";
import { useState } from "react";
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
    <section className="panel" aria-labelledby="repos-heading">
      <h2 id="repos-heading">Repositories</h2>
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name, source, location });
        }}
      >
        <input
          aria-label="Repository name"
          placeholder="e.g. gate-firmware"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <select
          aria-label="Repository source"
          value={source}
          onChange={(e) => setSource(e.target.value as RepositorySource)}
        >
          <option value="local_path">Local path</option>
          <option value="remote_url">Remote URL</option>
        </select>
        <input
          aria-label="Repository location"
          placeholder={source === "local_path" ? "/srv/repos/…" : "https://github.com/…"}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          required
        />
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Connecting…" : "Connect repository"}
        </button>
      </form>
      {create.error && (
        <p className="error" role="alert">
          {create.error.message}
        </p>
      )}
      <ul className="chips">
        {(list.data ?? []).map((r) => (
          <li key={r.id}>
            {r.name} <span className="tag">{r.source}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
