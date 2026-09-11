/**
 * The canned steers the composer offers behind a leading `/`.
 *
 * Three questions an operator asks a running harness often enough to have typed them out many
 * times, and the one command that is not a message. The texts are deliberately plain requests —
 * the harness reads them as a user turn, exactly as if they had been typed — so they carry no
 * protocol and can be reworded here without touching anything else.
 *
 * One table, and short on purpose: a `/` menu with twelve entries is a second command palette,
 * and the composer is not the place for one.
 */
export interface ComposerSteer {
  /** What follows the slash. */
  command: string;
  /** One line, for the menu. */
  label: string;
  /** The message it expands into — or none, for a steer that is an action rather than a turn. */
  text?: string;
  /** The action, when it is one. */
  action?: "stop";
}

export const STEERS: readonly ComposerSteer[] = [
  {
    command: "status",
    label: "Ask for a progress summary",
    text: "Summarise what you have done so far, what is left, and anything blocking you.",
  },
  {
    command: "test",
    label: "Ask for the tests to be run",
    text: "Run the project's test suite now and report the result before continuing.",
  },
  {
    command: "wrap",
    label: "Ask for the work to be brought to a reviewable state",
    text: "Wrap up: finish the current change, make sure it builds and the tests pass, and leave the worktree ready for review.",
  },
  { command: "stop", label: "Stop the harness", action: "stop" },
];

/**
 * The steers a draft is asking for, or none.
 *
 * Only a draft that is *just* a slash command counts — a `/` on the first line of a longer
 * message, or anywhere else, is the operator's own text. Matching is by prefix on the command,
 * so `/st` narrows to `status` and `stop` and `/` alone offers everything.
 */
export function matchSteers(draft: string): readonly ComposerSteer[] {
  if (!draft.startsWith("/") || draft.includes("\n") || draft.includes(" ")) return [];
  const prefix = draft.slice(1).toLowerCase();
  return STEERS.filter((steer) => steer.command.startsWith(prefix));
}
