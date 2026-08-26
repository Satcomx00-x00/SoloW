/**
 * A tiny fetch wrapper shared by every driver. Not a generic HTTP client — just the two things
 * every provider call needs: throw a typed `ScmProviderError` on a non-2xx response (so a
 * caller never has to remember to check `res.ok`), and never let the token leak into the error
 * message.
 */
import { type ScmProvider, ScmProviderError } from "./types.js";

export async function scmFetch(
  provider: ScmProvider,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    // The body sometimes carries a useful reason ("Not Found", "401 Unauthorized"); the request
    // headers (which hold the token) never do, because they are never included here.
    const body = await res.text().catch(() => "");
    throw new ScmProviderError(
      provider,
      `${provider} request to ${url} failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  return res.json();
}

/**
 * A request that **changes something** — the mutating counterpart to `scmFetch`.
 *
 * Its own function rather than a `method` option on `scmFetch`, because the distinction is worth
 * being unable to lose. A write sent as a GET is accepted by every provider here (the path exists;
 * it just reads) and answers 200 with the *unchanged* issue — so the caller reads back a plausible
 * object, believes the write landed, and nothing anywhere reports a failure. That is exactly how
 * GitLab's project-field write shipped as a no-op whose test asserted the query string and never
 * the verb.
 *
 * A body is optional: some providers take their whole patch in the query string.
 */
export async function scmSend(
  provider: ScmProvider,
  url: string,
  headers: Record<string, string>,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    // The provider's own refusal is the useful part — "Validation Failed: assignee not found" is
    // a sentence an operator can act on. The request headers, which hold the token, are never
    // included here (Principle IV).
    const text = await res.text().catch(() => "");
    throw new ScmProviderError(
      provider,
      `${provider} ${method} to ${url} failed: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  // A 204 has no body, and `res.json()` on one throws — a write that succeeded must not surface
  // as a parse failure.
  if (res.status === 204) return undefined;
  return res.json().catch(() => undefined);
}

/**
 * A GraphQL POST, for the one API that offers nothing else.
 *
 * GitHub Projects v2 has no REST equivalent — reading a project's fields and writing a value are
 * GraphQL-only operations — so this exists rather than bending `scmFetch`, whose whole shape is a
 * GET that throws on a non-2xx.
 *
 * The difference that matters: **GraphQL answers 200 with an `errors` array.** A caller checking
 * `res.ok` would read a failed query as an empty result and quietly render an empty project, so
 * the errors are surfaced as the same `ScmProviderError` a 4xx produces. The token is never in
 * the message, for the same reason it is never in `scmFetch`'s (Principle IV).
 */
export async function scmGraphql<T>(
  provider: ScmProvider,
  url: string,
  headers: Record<string, string>,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ScmProviderError(
      provider,
      `${provider} GraphQL request failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  const payload = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (payload.errors && payload.errors.length > 0) {
    const reasons = payload.errors
      .map((e) => e.message ?? "unknown")
      .slice(0, 3)
      .join("; ");
    throw new ScmProviderError(provider, `${provider} GraphQL error: ${reasons}`);
  }
  if (!payload.data) {
    throw new ScmProviderError(provider, `${provider} GraphQL returned no data`);
  }
  return payload.data;
}

/**
 * Run one per-item provider call across a list, a few at a time.
 *
 * Some facts only exist per item: the change requests a provider links to an issue live on that
 * issue, not in the list endpoint that returned it (issue #128). So a driver has to fan out, and
 * how wide it fans is the whole question. Unbounded `Promise.all` over a hundred issues is what
 * trips GitHub's *secondary* rate limit — the one that punishes concurrency rather than volume,
 * and that costs the repository its whole sync — while a plain sequential loop makes a first
 * import a hundred round trips end to end.
 *
 * A small window is the compromise, and small on purpose: this runs behind a poll, where a few
 * extra seconds cost nothing and being throttled costs everything.
 */
export async function mapConcurrently<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      out[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Is this the provider saying "slow down"?
 *
 * Read out of the message because a driver throws `ScmProviderError` carrying the status in its
 * text rather than a typed code — the same text the orchestrator's own backoff already matches
 * on, which is why a rethrow from here lands as "the provider is rate limiting this connection"
 * without either side knowing about the other.
 *
 * Narrow on purpose. Mistaking an ordinary 404 for a throttle would fail a listing that was
 * merely missing a side endpoint.
 */
export function isRateLimited(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /\b429\b|rate limit|too many requests/i.test(text);
}

/**
 * Is this the provider saying "there is no such thing"?
 *
 * Matched on the message for the same reason `isRateLimited` is. Kept just as narrow: a 404 is
 * the one status a caller may legitimately turn into `null`, and widening this to any failure
 * would turn "your token expired" into "that repository does not exist" — an answer that reads
 * like a fact and sends the operator looking in the wrong place.
 *
 * Note that a provider answers 404 both for a repository that is absent and for one the token
 * cannot see; that ambiguity is the provider's, and callers must not resolve it by guessing.
 */
export function isNotFound(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /\b404\b|not found/i.test(text);
}

/**
 * The per-item enrichment fan-out, and the one failure it is not allowed to launder.
 *
 * An item whose side call failed comes back `undefined` — *unknown*, which the caller turns into
 * an omitted field. It must never come back as an empty answer: "this issue has no linked change
 * request" and "we could not find out" look identical in a table, and only one of them is a fact.
 *
 * A rate limit is the exception, and it **throws**. Two reasons, and the second is the one that
 * decides it:
 *
 *  - Continuing to fan out after a 429 spends requests that make the throttle worse and cannot
 *    be trusted to answer, so the remaining workers drain without issuing a call.
 *  - A poll reads incrementally, on a watermark. If the listing succeeded with the field merely
 *    unknown, the watermark would advance past those issues and they would never be asked about
 *    again — the throttle would become permanent missing data with nothing to show for it.
 *    Failing the listing keeps the watermark where it was, so the next pass retries them.
 */
export async function enrichConcurrently<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<R | undefined>> {
  let throttled: unknown;
  const out = await mapConcurrently<T, R | undefined>(items, limit, async (item) => {
    if (throttled !== undefined) return undefined;
    try {
      return await fn(item);
    } catch (cause) {
      if (isRateLimited(cause)) throttled ??= cause;
      return undefined;
    }
  });
  if (throttled !== undefined) throw throttled;
  return out;
}

/**
 * How many rows one page asks for, and how many pages a listing will walk.
 *
 * Exported because the *caller* has to be able to tell a complete read from a truncated one: a
 * listing that returned exactly `ISSUE_PAGE_SIZE * ISSUE_PAGE_CAP` rows is one that stopped, and
 * a sync that advanced its watermark past a stop would never ask for the rest again.
 */
export const ISSUE_PAGE_SIZE = 100;
export const ISSUE_PAGE_CAP = 50;

/**
 * Walk a paged REST listing until it runs out, or until the cap.
 *
 * Written because every driver here fetched exactly one page of 100 and returned it as though it
 * were the listing. On a repository with 150 issues that silently dropped 50 — and the sync then
 * advanced its watermark past them, so they were never asked for again. A first import of a
 * 1000-issue backlog kept 100 of it, permanently.
 *
 * A short page ends the walk: it is the one signal every one of these APIs gives that there is
 * nothing more, and it costs no extra request to read.
 */
export async function scmFetchPaged<T>(
  provider: ScmProvider,
  url: (page: number) => string,
  headers: Record<string, string>,
  pageSize: number = ISSUE_PAGE_SIZE,
  pageCap: number = ISSUE_PAGE_CAP,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= pageCap; page++) {
    const rows = (await scmFetch(provider, url(page), headers)) as T[];
    if (!Array.isArray(rows)) break;
    all.push(...rows);
    // A page that came back short is the last one. A full page means "ask again", which is the
    // only reason this loop exists.
    if (rows.length < pageSize) break;
  }
  return all;
}
