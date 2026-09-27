import type { RunLinkDto, SessionEventPayload } from "@solow/contracts";
import { orderRunLinks, runLinksIn } from "@solow/core";

/** The two fields of a log row this module reads; the DAL's row type is wider. */
interface LogRow {
  kind: string;
  payload: unknown;
}

/**
 * Where the run went outside this app, read back out of its own log.
 *
 * Which rows count is the whole of the decision here, and it is a decision about evidence.
 *
 *  - **Tool results.** `glab mr create`, `gh pr create` and `git push` print the URL of the
 *    thing they just made. This is the row that proves the run did it.
 *  - **Tool inputs.** A command naming a URL — `gh pr view <url>`, `glab ci status --url` — is
 *    the run acting on that resource, which is still an action a reviewer wants a door to.
 *  - **What the model said, and what the machinery said.** A harness that reports "opened !42"
 *    is quoting a URL it got from one of the above; a run whose output was truncated may leave
 *    this as the only surviving copy.
 *
 * Deliberately not read: the operator's own turns, because a link *they* pasted into the brief
 * is the ask, not something the run did; and thinking, because a URL the model composed while
 * reasoning is not evidence that anything exists at the other end of it.
 */
export function sessionRunLinks(events: readonly LogRow[]): RunLinkDto[] {
  const links: RunLinkDto[] = [];
  for (const event of events) {
    const payload = event.payload as SessionEventPayload | null;
    if (!payload) continue;
    switch (payload.kind) {
      case "tool_result":
        links.push(...runLinksIn(payload.output));
        break;
      case "tool_call":
        // A flat map of short strings by contract (`tool_call.input`), so every value is worth
        // a look rather than only the one key that happens to be named `command` today.
        for (const value of Object.values(payload.input ?? {})) links.push(...runLinksIn(value));
        break;
      case "assistant_turn":
        if (!payload.thinking) links.push(...runLinksIn(payload.text));
        break;
      case "notice":
        links.push(...runLinksIn(payload.text));
        break;
      case "widget":
        // The completion report, which is where a well-behaved harness names what it opened.
        if (payload.widget.kind === "task_complete")
          links.push(...runLinksIn(payload.widget.summary));
        break;
      default:
        break;
    }
  }
  return orderRunLinks(links);
}
