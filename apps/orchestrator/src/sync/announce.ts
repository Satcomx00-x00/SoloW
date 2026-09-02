import type { TaskEvent } from "@solow/contracts";

/**
 * Telling open screens that the mirror moved.
 *
 * The counterpart to the poll: `syncRepositoryIssues` writes what the provider changed, and this
 * is how a tab that is already open finds out, without asking. A `mirror` frame on the
 * Workspace's board channel is a nudge to re-read — never the rows themselves, which would make
 * the socket a second answer to a question the API already answers.
 *
 * Announced per Workspace rather than per repository, because that is the granularity a client
 * can act on: the screens that read mirrored rows (the project table, the issue list, the board's
 * issue references) are Workspace-scoped queries, and there is nothing useful a tab could do with
 * "repository 7 changed" that it does not already do with "issues changed".
 */

/** The slice of the hub this needs — injected so the announcement can be asserted in a test. */
export interface MirrorAudience {
  boardChannel(workspaceId: string): string;
  publish(channel: string, event: TaskEvent): void;
}

/** What a pass changed, collected while it runs. */
export class MirrorChanges {
  private readonly issues = new Set<string>();
  private readonly labels = new Set<string>();

  /** Record that a Workspace's mirrored issues moved. Nothing is announced for a no-op pass. */
  issuesChanged(workspaceId: string): void {
    this.issues.add(workspaceId);
  }

  labelsChanged(workspaceId: string): void {
    this.labels.add(workspaceId);
  }

  get empty(): boolean {
    return this.issues.size === 0 && this.labels.size === 0;
  }

  /**
   * Publish one frame per Workspace per scope, and answer how many went out.
   *
   * Deliberately not deduplicated across scopes: a client invalidates a different set of queries
   * for `issues` than for `labels`, and collapsing the two into one "something changed" would
   * make every label refresh re-read every issue list in every open tab — the cost this whole
   * mechanism exists to avoid, reintroduced at the client.
   *
   * A Workspace with nobody watching costs nothing: `publish` on a channel with no subscribers
   * returns immediately.
   */
  announce(hub: MirrorAudience, now: () => Date = () => new Date()): number {
    const at = now().toISOString();
    let sent = 0;
    for (const [scope, workspaces] of [
      ["issues", this.issues],
      ["labels", this.labels],
    ] as const) {
      for (const workspaceId of workspaces) {
        hub.publish(hub.boardChannel(workspaceId), { kind: "mirror", scope, at });
        sent += 1;
      }
    }
    return sent;
  }
}
