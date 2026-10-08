import { decryptForScmSync } from "@solow/db";
import { cloneUsernameFor, providerManifest, providerWith } from "@solow/scm";
import type { TaskRepositoryBinding } from "./data.js";
import type { CloneCredential } from "./worktree/manager.js";

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
  // What is useful in a git or provider error is its first lines; the rest is usually a hint
  // block or a repeated command line.
  return clean.trim().split("\n").slice(0, 3).join(" ").slice(0, 300);
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
