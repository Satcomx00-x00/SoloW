/**
 * The things a run did *outside* this app, read back out of what it printed.
 *
 * A harness that opens a merge request or starts a pipeline leaves the only record of it in the
 * transcript: `glab mr create` prints the MR's URL, `git push` prints the pipeline's, `gh pr
 * create` prints the pull request's. A reviewer who wanted to look at either had to scroll a few
 * hundred tool calls, find the line, and copy the URL out of a `<pre>`. The URLs are evidence
 * the log already holds; this turns them into the one thing anyone does with them.
 *
 * Read, never written. Nothing here asks a provider anything — an MR that was opened and then
 * closed still has a page, and a link to it is still the honest answer to "where did this go".
 * The provider's own page is what says what state it is in now.
 *
 * Pure, and provider-shaped rather than provider-configured: the three forges this build speaks
 * to (`@solow/scm`) put these resources at path shapes that are stable across self-hosted
 * instances, so a URL is classified by its path and not by a host anyone had to register.
 */

/**
 * What a link points at, in the order a reviewer asks for it: where the change was proposed,
 * whether it built, what exactly landed, what was cut, and what it was for.
 */
export const RUN_LINK_KINDS = ["merge_request", "pipeline", "commit", "release", "issue"] as const;
export type RunLinkKind = (typeof RUN_LINK_KINDS)[number];

export interface RunLink {
  kind: RunLinkKind;
  /**
   * The resource's own page, canonicalised — `…/merge_requests/42`, never the `/diffs` tab or
   * the `#note_1` anchor the harness happened to paste. Two mentions of one MR are one button.
   */
  url: string;
  /** How it is named where it lives: "Merge request !42", "Pull request #7", "Pipeline #1204". */
  label: string;
  /** The instance serving it, for a page that may show links from more than one. */
  host: string;
  /** `owner/repo`, or the full group path on GitLab; null when the URL does not say. */
  repository: string | null;
}

/** A commit sha, as either forge writes it in a URL — short or full, never a branch name. */
const SHA = /^[0-9a-f]{7,40}$/i;

const isNumber = (part: string | undefined): part is string =>
  part !== undefined && /^\d+$/.test(part);

/**
 * The GitLab shapes, taken from after the `/-/` separator.
 *
 * The separator is what makes a group path of any depth unambiguous: everything before it is the
 * project, everything after it is the resource. Old instances wrote these paths without it, so
 * the caller also tries the tail on its own.
 */
function gitlabResource(
  rest: readonly string[],
): { kind: RunLinkKind; label: string; take: number } | null {
  const [type, id] = rest;
  if (type === "merge_requests" && isNumber(id)) {
    // `!42` is how GitLab itself refers to a merge request; `/merge_requests/new` is not one.
    return { kind: "merge_request", label: `Merge request !${id}`, take: 2 };
  }
  if (type === "pipelines" && isNumber(id))
    return { kind: "pipeline", label: `Pipeline #${id}`, take: 2 };
  if (type === "jobs" && isNumber(id)) return { kind: "pipeline", label: `Job #${id}`, take: 2 };
  if (type === "issues" && isNumber(id)) return { kind: "issue", label: `Issue #${id}`, take: 2 };
  if (type === "commit" && id !== undefined && SHA.test(id)) {
    return { kind: "commit", label: `Commit ${id.slice(0, 7)}`, take: 2 };
  }
  if (type === "releases" && id !== undefined && id !== "") {
    return { kind: "release", label: `Release ${decodeURIComponent(id)}`, take: 2 };
  }
  return null;
}

/**
 * The GitHub shapes, which Gitea and Forgejo copy almost exactly — `pulls` for `pull` being the
 * one difference that matters here, and both are accepted rather than guessed at from the host.
 */
function githubResource(
  rest: readonly string[],
): { kind: RunLinkKind; label: string; take: number } | null {
  const [type, a, b] = rest;
  if ((type === "pull" || type === "pulls") && isNumber(a)) {
    return { kind: "merge_request", label: `Pull request #${a}`, take: 2 };
  }
  if (type === "issues" && isNumber(a)) return { kind: "issue", label: `Issue #${a}`, take: 2 };
  if (type === "commit" && a !== undefined && SHA.test(a)) {
    return { kind: "commit", label: `Commit ${a.slice(0, 7)}`, take: 2 };
  }
  if (type === "actions" && a === "runs" && isNumber(b)) {
    return { kind: "pipeline", label: `Actions run #${b}`, take: 3 };
  }
  // A check run, which is where a failing status check on a pull request links to.
  if (type === "runs" && isNumber(a))
    return { kind: "pipeline", label: `Check run #${a}`, take: 2 };
  if (type === "releases" && a === "tag" && b !== undefined && b !== "") {
    return { kind: "release", label: `Release ${decodeURIComponent(b)}`, take: 3 };
  }
  return null;
}

/**
 * One URL's link, or null when it names nothing a run *did* — a repository's home page, a raw
 * file, a docs site. Null is the common answer and is meant to be: the rail shows actions, and
 * a list that also carried every `https://` the model mentioned would not be a list of actions.
 */
export function runLinkOf(raw: string): RunLink | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const parts = parsed.pathname.split("/").filter((part) => part !== "");
  const marker = parts.indexOf("-");
  // GitLab first, by its separator: `group/sub/project/-/merge_requests/42`. Only a marker with
  // a project in front of it counts, so a repository literally named `-` cannot fake one.
  if (marker >= 1) {
    const resource = gitlabResource(parts.slice(marker + 1));
    if (resource) {
      const project = parts.slice(0, marker);
      const tail = parts.slice(marker + 1, marker + 1 + resource.take);
      return {
        kind: resource.kind,
        url: `${parsed.origin}/${[...project, "-", ...tail].join("/")}`,
        label: resource.label,
        host: parsed.host,
        repository: project.join("/"),
      };
    }
  }

  // Then the `owner/repo/<resource>` shape both forges share — and the separator-less GitLab
  // paths old instances still serve, which land here with the same two leading segments.
  if (parts.length >= 4) {
    const rest = parts.slice(2);
    const resource = githubResource(rest) ?? gitlabResource(rest);
    if (resource) {
      const repository = parts.slice(0, 2);
      return {
        kind: resource.kind,
        url: `${parsed.origin}/${[...repository, ...rest.slice(0, resource.take)].join("/")}`,
        label: resource.label,
        host: parsed.host,
        repository: repository.join("/"),
      };
    }
  }
  return null;
}

/**
 * Every URL in a blob of text, with the punctuation a sentence puts after one taken back off.
 *
 * A URL cannot contain a space, so the run is bounded by whitespace and by the brackets and
 * quotes that wrap one in prose, in markdown and in a shell command. Trailing `.`, `,` and `)`
 * are sentence, not URL — a link mentioned mid-sentence is otherwise dead on arrival.
 */
function urlsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\\)\]}]+/g)) {
    found.push(match[0].replace(/[.,;:!?]+$/, ""));
  }
  return found;
}

/** Every action link one piece of text names, in the order it names them. */
export function runLinksIn(text: string | null | undefined): RunLink[] {
  if (!text) return [];
  const links: RunLink[] = [];
  for (const url of urlsIn(text)) {
    const link = runLinkOf(url);
    if (link) links.push(link);
  }
  return links;
}

/** The same, over however many pieces of text a caller has — a whole log, or a live tail. */
export function runLinksFrom(texts: Iterable<string | null | undefined>): RunLink[] {
  const links: RunLink[] = [];
  for (const text of texts) links.push(...runLinksIn(text));
  return links;
}

/**
 * Default cap. A run that pushes thirty times prints thirty commit URLs, and a rail section that
 * grew to hold all of them would bury the merge request at the top of it — which is the one
 * link anyone came for.
 */
export const RUN_LINK_LIMIT = 12;

/**
 * Deduplicate and order for reading: the proposal first, then whether it built, then the detail.
 *
 * First mention wins within a kind, so the ordering is the run's own — the MR opened first is
 * the MR listed first. Two sources may both carry a link (the persisted log and the live
 * stream); they collapse here on the canonical URL rather than being reconciled by the caller.
 */
export function orderRunLinks(links: readonly RunLink[], limit = RUN_LINK_LIMIT): RunLink[] {
  const seen = new Map<string, RunLink>();
  for (const link of links) if (!seen.has(link.url)) seen.set(link.url, link);
  const rank = (kind: RunLinkKind) => RUN_LINK_KINDS.indexOf(kind);
  return [...seen.values()]
    .map((link, index) => ({ link, index }))
    .sort((a, b) => rank(a.link.kind) - rank(b.link.kind) || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.link);
}
