"use client";

import { trpc } from "@/trpc/react";

/**
 * How each installed provider spells its own name (F21).
 *
 * Every surface that shows where an Issue came from used to read a `Record` keyed by a closed
 * enum. With the set of providers open, that key can be one this build has never heard of — so
 * the names come from the registry instead, and anything not in it falls back to its own id.
 *
 * One query, shared: React Query dedupes it across every card, badge and menu on a page, so a
 * board of thirty cards asks once. The query is behind the integrations flag, and a Workspace
 * with that flag off simply has no names to look up — which is correct, because it has no
 * integrations either, and `issueSourceLabel`'s fallback covers the local Issues that remain.
 */
export function useProviderNames(): (providerId: string) => string | null {
  const providers = trpc.integration.providers.useQuery({}, { retry: false });
  const byId = new Map((providers.data ?? []).map((m) => [m.id, m.name]));
  return (providerId: string) => byId.get(providerId) ?? null;
}
