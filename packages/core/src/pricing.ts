/**
 * Cost derivation from recorded token usage (issue #14).
 *
 * The reason this is a *function over stored counts* rather than a column on `session_usage`:
 * a token count is a fact about a run that happened, and a price is an external opinion that
 * changes without warning. Storing a monetary figure would mean either freezing history at
 * whatever the price was on the day, or silently rewriting what a past run "cost" every time a
 * provider adjusts a rate. Both are wrong. Counts are recorded; cost is computed on demand.
 *
 * It also means usage capture never blocks on a price being known — which matters, because
 * capture cannot be deferred (the agent reports usage once) while a price table can be filled
 * in at any time.
 */

/** Price per million tokens, in USD. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Reading from the cache is cheaper than sending the tokens again. */
  cacheRead: number;
  /** Writing to the cache costs a premium over plain input. */
  cacheWrite: number;
}

/**
 * Known prices, keyed by an exact model identifier.
 *
 * Deliberately not exhaustive and deliberately not guessed: an unknown model yields `null`
 * rather than an invented number, so a missing entry shows up as "not priced" instead of as a
 * confidently wrong total. Add rows here as models are used; recorded history is unaffected.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-4-20250514": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

/** The token counts a usage record holds. */
export interface TokenUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const PER_MILLION = 1_000_000;

/**
 * Derive the USD cost of one turn, or `null` when the model is unknown or unstated.
 *
 * `null` is a real answer and callers must render it as "not priced" rather than as zero: a
 * turn that cost money we cannot price is not a free turn, and an aggregate that silently
 * treats it as one is misleading in the direction that flatters us.
 */
export function deriveCostUsd(
  usage: TokenUsage,
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): number | null {
  if (!usage.model) return null;
  const price = prices[usage.model];
  if (!price) return null;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    PER_MILLION
  );
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of the turns that could be priced. */
  costUsd: number;
  /** Turns whose model had no price — the reason `costUsd` may understate the truth. */
  unpricedTurns: number;
  /** Turns the agent reported no usage for at all. */
  unreportedTurns: number;
}

/**
 * Total a set of turns, keeping the two kinds of gap visible rather than folding them into the
 * number. A caller that shows `costUsd` without also showing `unpricedTurns` and
 * `unreportedTurns` is showing a lower bound and calling it a total.
 */
export function totalUsage(
  turns: readonly (TokenUsage & { reported: boolean })[],
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    unpricedTurns: 0,
    unreportedTurns: 0,
  };
  for (const turn of turns) {
    if (!turn.reported) {
      totals.unreportedTurns += 1;
      continue;
    }
    totals.inputTokens += turn.inputTokens;
    totals.outputTokens += turn.outputTokens;
    totals.cacheReadTokens += turn.cacheReadTokens;
    totals.cacheWriteTokens += turn.cacheWriteTokens;
    const cost = deriveCostUsd(turn, prices);
    if (cost === null) totals.unpricedTurns += 1;
    else totals.costUsd += cost;
  }
  return totals;
}
