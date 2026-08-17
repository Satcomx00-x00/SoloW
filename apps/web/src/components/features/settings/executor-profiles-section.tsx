"use client";

import { useState } from "react";
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
    <section className="panel" aria-labelledby="exec-heading">
      <h2 id="exec-heading">Executor profiles</h2>
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name, kind: "local" });
        }}
      >
        <input
          aria-label="Executor name"
          placeholder="e.g. Local executor"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Add executor"}
        </button>
      </form>
      {create.error && (
        <p className="error" role="alert">
          {create.error.message}
        </p>
      )}
      <ul className="chips">
        {(list.data ?? []).map((p) => (
          <li key={p.id}>
            {p.name} <span className="tag">{p.kind}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
