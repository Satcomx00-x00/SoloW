/**
 * A unique id for a repeater row — a React key, and nothing more.
 *
 * The two repeaters in Settings each called `crypto.randomUUID()` for this, which **throws over
 * plain HTTP**: that API exists only in a secure context, so it is present on `localhost` and
 * absent the moment the same install is opened from another machine on the LAN. Next prints that
 * second address on every boot (`Network: http://192.168.1.x:5000`), so the failure is on the
 * path the product itself invites — and it is not a degraded field, it is an uncaught TypeError
 * inside a `useState` initialiser, which takes the whole Settings page down to "Application
 * error: a client-side exception has occurred".
 *
 * A counter, because the requirement was never randomness. These ids exist so React can tell one
 * row from another across a re-render — the reason the rows are keyed by id rather than by index
 * is that removing a row must not hand its neighbour's key, focus and cursor to the row below.
 * A number that never repeats within a page load does that perfectly, and cannot fail.
 *
 * Never persisted, never sent anywhere: a row's id dies with the form it was typed into.
 */
let counter = 0;

export function newRowId(): string {
  counter += 1;
  return `row-${counter}`;
}
