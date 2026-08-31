/**
 * What a driver stops having to ask for twice.
 *
 * Every provider call in this package is a network round trip into somebody else's rate limit,
 * and two facts about those APIs make most of those trips avoidable:
 *
 *  - **They answer with an `ETag`, and they accept `If-None-Match`.** A conditional GET whose
 *    resource has not changed comes back `304` with no body — and on GitHub a 304 *does not spend
 *    a rate-limit point*. A poll over a repository nobody touched costs a header exchange instead
 *    of a paged listing.
 *  - **The same URL is asked for concurrently.** A board, an issue list and a sync pass reaching
 *    for the same labels at the same moment are three identical requests whose answers must be
 *    identical, because they are one resource.
 *
 * So this module holds two things: the bodies we may revalidate instead of re-download, and the
 * in-flight requests a second caller may join instead of duplicate.
 *
 * **Neither one is allowed to make an answer stale.** There is no time-based freshness here and
 * no `max-age`: a cached body is only ever returned when the provider itself has just said `304`
 * for it, in this very request. That is the property that makes this safe to put under every read
 * in the package — the caller sees exactly what an unconditional fetch would have returned, and
 * only the transfer is skipped.
 */
import { createHash } from "node:crypto";

/** A body worth revalidating, and the tag to revalidate it with. */
interface CacheEntry {
  readonly etag: string;
  readonly value: unknown;
  /** Response size, so eviction can bound memory rather than entry count alone. */
  readonly bytes: number;
}

/**
 * The ceilings, and why there are two.
 *
 * An entry count alone bounds a thousand tiny label lists and not one 40 MB issue page; a byte
 * budget alone lets a million empty answers accumulate their own overhead. Both are small on
 * purpose — this is a revalidation cache, not a store. Losing an entry costs one full response
 * body, never a wrong answer.
 */
const MAX_ENTRIES = 512;
const MAX_BYTES = 32 * 1024 * 1024;

/** Insertion-ordered, which is what makes a plain `Map` an LRU: re-inserting moves to the end. */
const entries = new Map<string, CacheEntry>();
let heldBytes = 0;

/** One entry per URL currently being fetched, so the second caller for it waits instead of asks. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * The token, reduced to something that can safely be a map key.
 *
 * **This is the part that must not be got wrong.** Two Workspaces can hold two tokens for the
 * same host, and `GET /repos/acme/secret` means a different thing to each: one is entitled to the
 * body and the other is entitled to a 404. Keying on the URL alone would serve the first token's
 * private repository to the second (Principle IV).
 *
 * A SHA-256 of the `Authorization` header, truncated — never the token itself, so a heap dump of
 * this map is not a credential leak, and the digest cannot be walked back to the header it came
 * from.
 */
function fingerprint(headers: Record<string, string>): string {
  const auth = headers.Authorization ?? headers.authorization ?? "";
  return createHash("sha256").update(auth).digest("base64url").slice(0, 22);
}

/**
 * The identity of a cached answer: who asked, with what credential, for which URL.
 *
 * A NUL byte separates the three, because it cannot occur in a provider name, in a base64url
 * digest or in a URL — so no two distinct triples can collide by concatenating into one string.
 */
export function cacheKey(provider: string, url: string, headers: Record<string, string>): string {
  return `${provider}\u0000${fingerprint(headers)}\u0000${url}`;
}

/** The tag to revalidate with, or undefined when nothing is held for this key. */
export function cachedEtag(key: string): string | undefined {
  return entries.get(key)?.etag;
}

/**
 * The body a `304` just confirmed, as a copy the caller owns.
 *
 * Structurally cloned rather than handed over, because the alternative is a shared mutable
 * object: two callers that both received the cached array, one of which sorts it in place, would
 * corrupt what the other is reading — and the cache would go on serving the mutated value as
 * though the provider had sent it. A clone costs microseconds against a round trip's
 * milliseconds, and it is what makes the cache invisible, which is the whole requirement.
 */
export function cachedValue(key: string): unknown {
  const hit = entries.get(key);
  if (!hit) return undefined;
  // Re-inserting is what marks it recently used; `entries` is ordered by insertion.
  entries.delete(key);
  entries.set(key, hit);
  return structuredClone(hit.value);
}

/**
 * Remember a body against its tag.
 *
 * A response with no `ETag` is not stored: nothing could ever revalidate it, so keeping it would
 * be holding memory to answer a question this module has decided never to answer from memory.
 *
 * Stored as a clone, for the mirror of the reason `cachedValue` returns one. The caller keeps the
 * object it just parsed and is free to sort or splice it; what stays here is a copy nothing else
 * holds a reference to, so the body handed out after the next `304` is still the body the
 * provider actually sent.
 */
export function remember(key: string, etag: string | null, value: unknown, bytes: number): void {
  if (!etag) return;
  const previous = entries.get(key);
  if (previous) heldBytes -= previous.bytes;
  entries.delete(key);
  entries.set(key, { etag, value: structuredClone(value), bytes });
  heldBytes += bytes;
  // Oldest first, which under insertion order is least recently used.
  for (const [oldest, entry] of entries) {
    if (entries.size <= MAX_ENTRIES && heldBytes <= MAX_BYTES) break;
    entries.delete(oldest);
    heldBytes -= entry.bytes;
  }
}

/**
 * Run `fetcher` for this key, unless an identical call is already running — in which case join it.
 *
 * The join is the point: a page that mounts three components each asking for the same labels
 * issues one request, not three, and the two that waited pay no latency the first did not already
 * pay. Each joiner gets its own clone, for the reason `cachedValue` gives.
 *
 * A rejection is shared too, deliberately. The second caller asking the same question of the same
 * host with the same token at the same moment would have received the same failure, and issuing
 * the request anyway to find that out is exactly the traffic this exists to remove.
 */
export async function coalesce<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const joined = inFlight.get(key);
  if (joined) return structuredClone(await joined) as T;
  const running = fetcher();
  inFlight.set(key, running);
  try {
    return await running;
  } finally {
    // Cleared in `finally` so a rejected request does not pin every later caller to its failure.
    inFlight.delete(key);
  }
}

/** Drop everything. For tests, which must not inherit one case's answers into the next. */
export function resetScmCache(): void {
  entries.clear();
  inFlight.clear();
  heldBytes = 0;
}

/** What is currently held — for tests, and for an operator asking why memory is what it is. */
export function scmCacheStats(): { entries: number; bytes: number; inFlight: number } {
  return { entries: entries.size, bytes: heldBytes, inFlight: inFlight.size };
}
