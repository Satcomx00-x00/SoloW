# 0020 — Cache provider reads by revalidation, never by expiry

**Status:** Accepted · **Date:** 2026-08-31 · **Deciders:** Architecture
**Builds on:** [0014](./0014-direct-api-source-integrations.md), [0018](./0018-provider-owned-project-fields.md) ·
**Affects:** [F01](../features/F01-issue-management.md), [F23](../features/F23-project-planning.md)

## Context

[0014](./0014-direct-api-source-integrations.md) put SoloW's integrations directly on the GitHub
and GitLab REST APIs, and [0018](./0018-provider-owned-project-fields.md) made the provider the
authority for planning values. Both consequences are now load-bearing, and both are paid in the
same currency: **every fact about an Issue is somebody else's network round trip, inside somebody
else's rate limit.**

0018 already recorded the resulting negative — *"latency and rate limits are now user-visible…
which the local cache hides for reads and cannot hide for writes."* That local cache is the
mirror in SQLite. It does nothing for the reads that go to the provider anyway: a sync poll, a
label list a dialog opens with, a repository listing.

Those reads had three costs that were not intrinsic to them:

1. **A poll over an unchanged repository paid full price.** Listing 1000 issues re-transferred
   1000 issues to discover that none had changed, and spent the rate limit to do it.
2. **A listing walked its pages one at a time.** Ten pages meant ten sequential round trips, each
   waiting on the last, for a page count the first response had already announced.
3. **Concurrent callers asking the identical question asked it separately.** Three components
   mounting at once with the same label list made three requests whose answers had to be equal.

The obvious fix for (1) and (3) is a cache with a time-to-live. That is the decision this record
exists to *refuse*.

## Decision

**Provider reads are cached for revalidation only. A cached body is returned when, and only when,
the provider has just answered `304 Not Modified` for it in that very request. There is no
time-to-live anywhere in this path.**

Concretely, in `packages/scm`:

- Every read carries `If-None-Match` when a body is held for that exact URL under that exact
  credential. A `304` returns the held body. On GitHub a 304 **does not spend a rate-limit
  point**, so an unchanged repository costs a header exchange.
- Two callers asking for the same URL with the same credential at the same moment share one
  request rather than issuing two.
- A listing reads pages 2..n concurrently when the first page's headers announce how many there
  are (`Link … rel="last"`, or GitLab's `x-total-pages`). A provider that announces nothing keeps
  the sequential walk.

The property all three preserve: **a caller sees exactly what an unconditional fetch would have
returned.** Only the cost changes. That is what makes this safe to put underneath every read in
the package rather than behind a per-call-site opt-in, and it is why no caller had to be changed
to benefit.

Two invariants the cache must not break, both held by tests that fail without them:

- **No credential's answer reaches another credential.** The key is the provider, the URL, and a
  SHA-256 of the `Authorization` header — never the token itself. Two Workspaces holding two
  tokens for one host get different answers to `GET /repos/acme/secret`, and one of them is a 404
  (Principle IV).
- **No caller can corrupt a later caller's body.** Values are cloned in and out, so a driver that
  sorts the array it was handed cannot change what the next `304` returns.

The browser-side counterpart is stated in the same spirit and is *not* the same mechanism: React
Query's `staleTime` **is** an expiry window, and it is safe there only because every write
invalidates what it affects and every live change arrives on the task stream. It governs one
case — a read nobody invalidated, on a screen being revisited.

## Considered options

- **Revalidation only (chosen).** Freshness stays the provider's answer. Nothing can be stale,
  so nothing has to be reasoned about per call site, and the cache is invisible in behaviour.
  The cost is that every read still makes a request; only the body and the rate-limit point are
  saved.

- **A short time-to-live (30–60 s) on provider reads.** Cheaper still — it removes the request
  as well as the transfer — and rejected because it makes staleness a property of the *transport*
  rather than of a screen. An Issue edited on GitHub and not shown here for a minute is a bug
  report against SoloW, and the mirror already has a defensible answer for "how current is this"
  (the sync watermark). A second, invisible, differently-timed staleness underneath it would make
  that answer untrue and unexplainable. Worth revisiting only per endpoint, with the window
  stated in the UI.

- **Speculative page prefetching.** Fetch pages ahead and discard the overshoot, rather than
  reading the announced count. Rejected: it buys the same latency out of the rate limit, which
  is the budget these listings are short of to begin with.

- **A shared cache across processes (Redis, SQLite).** Rejected as premature and as the wrong
  shape for a local-first product ([0008](./0008-data-store-strategy.md)): a bounded in-process
  LRU needs no deployment, and losing it costs one full response body, never a wrong answer.

## Consequences

- Positive: an incremental poll over quiet repositories becomes close to free, which is what
  makes polling more often affordable at all.
- Positive: a first import of a large backlog is bounded by the slowest page rather than by the
  sum of all of them.
- Positive: the whole package benefited without a driver changing, because the property is stated
  at the transport and not at the call sites.
- Negative: **memory is now held between requests.** Bounded by both an entry count and a byte
  budget, and small on purpose — but it is state a stateless fetch wrapper did not have, and it
  is per-process, so two workers hold two copies.
- Negative: **the cache is invisible when it misbehaves.** A stale-looking screen now has one more
  place to be wrong. `scmCacheStats()` exists so the question "what is it holding?" has an answer.
- Negative: providers that send no `ETag` gain nothing from the first two changes. Nothing is
  stored for them, which is correct and also silent — there is no signal that an endpoint is
  getting no benefit.
- Negative: concurrency against one host went up. The page fan-out is deliberately as narrow as
  the per-issue fan-out already in the drivers, because GitHub's *secondary* rate limit punishes
  concurrency rather than volume.

## Out of scope

- **Adaptive throttling on `x-ratelimit-remaining`.** Reading the budget and narrowing the
  fan-out as it runs down is the natural next step and a decision of its own; today the fan-out
  is a constant.
- **Retrying a `429` with its `Retry-After`.** The orchestrator's backoff already owns "the
  provider is rate limiting this connection", and moving it down here would give one behaviour
  two owners.
- **Caching writes, or reading a write back from cache.** `scmSend` is untouched. A mutation is
  never revalidated and never coalesced.
