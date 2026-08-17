"use client";

import type { SecretKind } from "@gatecontrol/contracts";
import { useState } from "react";
import { trpc } from "@/trpc/react";

/** Set (write-only) Secrets and list their metadata — the value is never shown after entry. */
export function SecretsSection() {
  const utils = trpc.useUtils();
  const secrets = trpc.secret.list.useQuery({});
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SecretKind>("api_key");
  const [value, setValue] = useState("");

  const setSecret = trpc.secret.set.useMutation({
    onSuccess: () => {
      utils.secret.list.invalidate();
      setName("");
      setValue("");
    },
  });

  return (
    <section className="panel" aria-labelledby="secrets-heading">
      <h2 id="secrets-heading">Secrets</h2>
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          setSecret.mutate({ name, kind, value });
        }}
      >
        <input
          aria-label="Secret name"
          placeholder="e.g. anthropic-api-key"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <select
          aria-label="Secret kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as SecretKind)}
        >
          <option value="api_key">API key</option>
          <option value="subscription_token">Subscription token</option>
        </select>
        <input
          aria-label="Secret value"
          type="password"
          placeholder="value (write-only)"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
        <button type="submit" disabled={setSecret.isPending}>
          {setSecret.isPending ? "Saving…" : "Save secret"}
        </button>
      </form>
      {setSecret.error && (
        <p className="error" role="alert">
          {setSecret.error.message}
        </p>
      )}
      <ul className="chips">
        {(secrets.data ?? []).map((s) => (
          <li key={s.id}>
            {s.name} <span className="tag">{s.kind}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
