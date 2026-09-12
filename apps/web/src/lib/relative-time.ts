/**
 * An age in words rather than a timestamp nobody converts in their head.
 *
 * Extracted from the comment thread when the status bar needed the same thing. Two copies of
 * this would have been two answers to "how long is a while ago" — they would have agreed until
 * one of them gained a unit.
 *
 * Past a fortnight a relative age stops being useful: "43d ago" is a date nobody can place, so
 * it becomes one.
 */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((now - then) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days <= 14 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

/**
 * The same units, looking forward: "in 5d", "in 3h", "in 12m" — for a deadline a reader is
 * measuring their own time against, such as when a Task leaves History. "now" once it has passed.
 */
export function relativeUntil(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((then - now) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
