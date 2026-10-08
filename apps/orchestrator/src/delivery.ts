import { type Db, decryptForScmSync } from "@solow/db";
import { cloneUsernameFor, providerManifest, providerWith } from "@solow/scm";
import { setTaskRepositoryChangeRequest, type TaskRepositoryBinding } from "./data.js";
import { worktreeNameForTask } from "./harness/claude-code-runner.js";
import { type CloneCredential, worktreeBranch } from "./worktree/manager.js";

/**
 * Shipping an approved branch: push it, then open or refresh its pull request (A1).
 *
 * Kept out of the run engine's body for two reasons. It is the one part of approval that talks to
 * a provider, which can be down, rate-limited or refuse a token, so it needs a failure it can name
 * in plain words. And C4 splits integration into its own unit; this is already shaped like one.
 *
 * Nothing here touches the host: the push is handed in as a callback bound to the orchestrator's
 * own executor, so the executor-boundary audit has one place to look (`pushWorktreeBranch`).
 */

/** What approval did for one Repository, for the Task to show. */
export type DeliveryOutcome =
  /** No remote to ship to: the work is a commit on a local branch, and the UI says so. */
  | { kind: "local"; reason: string }
  | { kind: "opened" | "updated"; url: string; number: number; noun: string };

/**
 * A failure to push or to open the request, already in words a person can act on.
 *
 * `stage` says how far delivery got, because the two have different remedies: a failed push means
 * the remote has nothing, a failed request means the branch is there and only the request is not.
 */
export class DeliveryError extends Error {
  constructor(
    readonly stage: "push" | "request",
    message: string,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

/** The shortest sha-looking base is not a branch name a provider can open a request against. */
const SHA_LIKE = /^[0-9a-f]{7,40}$/i;

/** Strip the token from any text about to be shown or logged (Principle IV). */
function scrub(text: string, token: string): string {
  const clean = token ? text.split(token).join("***") : text;
  // What is useful in a git or provider error is its first few lines — git's `remote:` and
  // `fatal:` ones. Its `hint:` block is advice about git, not about this repository.
  return clean
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("hint:"))
    .slice(0, 4)
    .join(" ")
    .slice(0, 500);
}

/**
 * Whether approval of this binding can ship at all.
 *
 * Only a Repository imported through an Integration has everything delivery needs: a remote, the
 * provider's own name for the repository, and a token that can write to it. A local path, or a
 * bare URL with no Integration, has no way to open a request, and is committed locally as before.
 */
export function deliverable(binding: TaskRepositoryBinding): boolean {
  const { repository, scmClone } = binding;
  return (
    repository.source === "remote_url" &&
    scmClone !== null &&
    repository.externalFullName !== null &&
    providerWith(scmClone.provider, "changeRequests") !== null
  );
}

/**
 * Whether `branch` is one this Task owns outright, and so one delivery may force-push.
 *
 * Exactly two names qualify, both derived from the Task id: the branch SoloW provisions
 * (`worktreeBranch`) and the one Claude Code creates for the worktree SoloW asks it for
 * (`worktree-<worktreeNameForTask>`, its own naming). Nothing else, and in particular not an
 * attachment's `checkoutBranch` the Owner named: that may be `main`, or a branch another Task
 * works on too, and a forced push there would rewrite history no one asked SoloW to touch.
 *
 * Refusing those rather than pushing them more carefully is deliberate. Making a forced push safe
 * on a shared name needs the repository's default branch (a provider call) and the last commit
 * SoloW itself pushed there (state nobody records), and still leaves two Tasks racing for one
 * branch. A Task's own name has a single writer by construction, so the force is safe as it is,
 * and a hand-named branch stays a local commit for the Owner to push.
 */
export function taskOwnsBranch(taskId: string, branch: string): boolean {
  return branch === worktreeBranch(taskId) || branch === `worktree-${worktreeNameForTask(taskId)}`;
}

export async function deliverBranch(args: {
  binding: TaskRepositoryBinding;
  branch: string;
  title: string;
  body: string;
  /** Pushes `branch` to `remoteUrl`; bound by the caller to the orchestrator's executor. */
  push: (remoteUrl: string, credential: CloneCredential) => Promise<void>;
}): Promise<DeliveryOutcome> {
  const { binding, branch } = args;
  if (!deliverable(binding)) {
    return {
      kind: "local",
      reason:
        binding.repository.source === "local_path"
          ? "This repository is a local folder with no remote."
          : "This repository is not connected to GitHub, GitLab or Gitea.",
    };
  }
  const { repository, scmClone, attachment } = binding;
  if (!taskOwnsBranch(attachment.taskId, branch)) {
    throw new DeliveryError(
      "push",
      `Did not push ${branch}: SoloW only pushes the branch it created for this task (${worktreeBranch(attachment.taskId)}), and ${branch} was named by hand, so it may be shared with other work. The change is committed on ${branch} locally; push it yourself if that is where it belongs.`,
    );
  }
  // `deliverable` established all three; re-read for the type system rather than asserting.
  const driver = scmClone && providerWith(scmClone.provider, "changeRequests");
  const repoRef = repository.externalFullName;
  if (!scmClone || !driver || !repoRef) throw new Error("unreachable: checked by deliverable()");

  const token = decryptForScmSync(scmClone.secretCiphertext);
  const noun = providerManifest(scmClone.provider)?.changeRequestNoun ?? "pull request";

  try {
    await args.push(repository.location, { username: cloneUsernameFor(scmClone.provider), token });
  } catch (cause) {
    const detail = scrub(cause instanceof Error ? cause.message : String(cause), token);
    throw new DeliveryError(
      "push",
      `Could not push ${branch} to ${repoRef}. Check that the connected token is allowed to write to the repository. (${detail})`,
    );
  }

  try {
    const base =
      attachment.baseRef && !SHA_LIKE.test(attachment.baseRef) ? attachment.baseRef : undefined;
    const { changeRequest, created } = await driver.upsertChangeRequest(
      { token, baseUrl: scmClone.baseUrl },
      repoRef,
      { head: branch, title: args.title, body: args.body, ...(base ? { base } : {}) },
    );
    return {
      kind: created ? "opened" : "updated",
      url: changeRequest.url,
      number: changeRequest.number,
      noun,
    };
  } catch (cause) {
    const detail = scrub(cause instanceof Error ? cause.message : String(cause), token);
    throw new DeliveryError(
      "request",
      `Pushed ${branch} to ${repoRef}, but could not open the ${noun}. (${detail})`,
    );
  }
}

/** What the request says about itself: where it came from and the Issue's own words. */
export function changeRequestBody(taskId: string, issueDescription: string | null): string {
  const brief = issueDescription?.trim().slice(0, 4000);
  return [`Opened by SoloW after the change from task \`${taskId}\` was approved.`, brief]
    .filter(Boolean)
    .join("\n\n");
}

/** What shipping one attachment came to, in the terms the notices below are written in. */
export type ShipResult =
  /** No remote: the commit is the result, and there is nothing to say about shipping it. */
  | { kind: "local" }
  /** The request is open; `line` names it for the session log. */
  | { kind: "shipped"; line: string }
  /** Committed, not shipped; `error` is already in words a person can act on. */
  | { kind: "failed"; branch: string; error: string };

/**
 * Ship one attachment's committed branch and record where it went (A1).
 *
 * The one place both callers go through — the approval that commits the branch, and Ship again,
 * which only ships one that is already committed — so the two cannot record a request
 * differently or describe a failure in different words. Never throws: a refusal is a result the
 * caller reports, and `report` hears about anything that was not a `DeliveryError`, which is a
 * bug rather than a provider saying no.
 */
export async function shipAttachment(
  db: Db,
  workspaceId: string,
  args: {
    binding: TaskRepositoryBinding;
    branch: string;
    title: string;
    body: string;
    push: (remoteUrl: string, credential: CloneCredential) => Promise<void>;
    report?: (cause: unknown) => void;
  },
): Promise<ShipResult> {
  try {
    const outcome = await deliverBranch(args);
    if (outcome.kind === "local") return { kind: "local" };
    await setTaskRepositoryChangeRequest(db, workspaceId, args.binding.attachment.id, {
      url: outcome.url,
      number: outcome.number,
    });
    return {
      kind: "shipped",
      line: `${args.binding.repository.name}: ${outcome.noun} #${outcome.number} ${outcome.kind} (${outcome.url})`,
    };
  } catch (cause) {
    if (!(cause instanceof DeliveryError)) args.report?.(cause);
    return {
      kind: "failed",
      branch: args.branch,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** The session-log line for an approval whose every remote half landed. */
export function shippedNotice(delivered: readonly string[]): string {
  return `Shipped: ${delivered.join("; ")}.`;
}

/**
 * The session-log line for an approval that committed and did not ship.
 *
 * It names the way out, because the Task page puts it beside this failure: Ship again pushes the
 * committed branch and opens the request without running anything, and Keep local finishes the
 * Task with the commit on this machine as its result — the answer for a token that may only read.
 */
export function deliveryFailedNotice(args: {
  undelivered: ReadonlyArray<{ branch: string; error: string }>;
  delivered: readonly string[];
}): string {
  return [
    "Your approval is recorded and the change is committed, but it was not shipped.",
    ...args.undelivered.map((u) => `${u.branch}: ${u.error}`),
    ...(args.delivered.length > 0 ? [shippedNotice(args.delivered)] : []),
    "The branch holds the change in the repository on this machine. Fix the cause above, then choose Ship again to push it and open the request — nothing is run again. Or choose Keep local to finish the task without shipping.",
  ].join(" ");
}

/**
 * The session-log line for an approval that integrated only part of a Task (issue #70 AC-4).
 *
 * The repositories that did integrate were also shipped (A1), so the line says what became of
 * each: a request already open on the provider is not a branch to "decide about by hand", and one
 * that failed to push is a second thing to fix, not something the reviewer should assume landed.
 */
export function partialIntegrationNotice(args: {
  integrated: readonly string[];
  failed: ReadonlyArray<{ branch: string; error: string }>;
  delivered: readonly string[];
  undelivered: ReadonlyArray<{ branch: string; error: string }>;
}): string {
  return [
    "Approval integrated only part of this task.",
    args.integrated.length > 0
      ? `Committed and recorded: ${args.integrated.join(", ")}.`
      : "Nothing was committed.",
    `Not integrated: ${args.failed.map((f) => `${f.branch} (${f.error})`).join("; ")}.`,
    ...(args.delivered.length > 0 ? [shippedNotice(args.delivered)] : []),
    ...(args.undelivered.length > 0
      ? [
          `Committed but not shipped: ${args.undelivered.map((u) => `${u.branch} (${u.error})`).join("; ")}.`,
        ]
      : []),
    args.delivered.length > 0
      ? "The branches listed as committed are real and already hold the change, and the requests listed as shipped are open — decide what to do with them by hand."
      : "The branches listed as committed are real and already hold the change — decide what to do with them by hand.",
  ].join(" ");
}
