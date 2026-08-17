"use client";

import type { AuthMode } from "@gatecontrol/contracts";
import { useState } from "react";
import { trpc } from "@/trpc/react";

/** Create Agent Profiles (auth mode + concurrency cap) bound to a stored Secret. */
export function AgentProfilesSection() {
  const utils = trpc.useUtils();
  const profiles = trpc.profile.agent.list.useQuery({});
  const secrets = trpc.secret.list.useQuery({});
  const [name, setName] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("subscription");
  const [secretId, setSecretId] = useState("");
  const [cap, setCap] = useState(3);

  const create = trpc.profile.agent.create.useMutation({
    onSuccess: () => {
      utils.profile.agent.list.invalidate();
      setName("");
    },
  });

  const secretOptions = secrets.data ?? [];

  return (
    <section className="panel" aria-labelledby="agents-heading">
      <h2 id="agents-heading">Agent profiles</h2>
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({
            name,
            agentKind: "claude_code",
            authMode,
            secretId,
            concurrencyCap: cap,
          });
        }}
      >
        <input
          aria-label="Profile name"
          placeholder="e.g. Claude Code (subscription)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <select
          aria-label="Auth mode"
          value={authMode}
          onChange={(e) => setAuthMode(e.target.value as AuthMode)}
        >
          <option value="subscription">Subscription</option>
          <option value="api_key">API key</option>
        </select>
        <select
          aria-label="Secret"
          value={secretId}
          onChange={(e) => setSecretId(e.target.value)}
          required
        >
          <option value="" disabled>
            Select a secret…
          </option>
          {secretOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.kind})
            </option>
          ))}
        </select>
        <input
          aria-label="Concurrency cap"
          type="number"
          min={1}
          max={20}
          value={cap}
          onChange={(e) => setCap(Number(e.target.value))}
        />
        <button type="submit" disabled={create.isPending || secretOptions.length === 0}>
          {create.isPending ? "Creating…" : "Add profile"}
        </button>
      </form>
      {secretOptions.length === 0 && (
        <p className="hint">Add a secret first to create a profile.</p>
      )}
      {create.error && (
        <p className="error" role="alert">
          {create.error.message}
        </p>
      )}
      <ul className="chips">
        {(profiles.data ?? []).map((p) => (
          <li key={p.id}>
            {p.name} <span className="tag">{p.authMode}</span>
            <span className="tag">cap {p.concurrencyCap}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
