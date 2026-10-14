import type { RepositoryDto, TaskRepositoryDto } from "@solow/contracts";
import { ExternalLink } from "lucide-react";

/**
 * Where an approved branch ended up, for one attachment (A1).
 *
 * Its own component so the Task page takes one line to show it. A request (a link, in the
 * provider's own word for it), a branch that is committed but not on the remote (said in words,
 * so nobody assumes it was pushed), and nothing yet (not approved). "No remote" is said only of a
 * Repository that has none: a remote one whose shipping failed, or one approved before shipping
 * existed, is not described as if it could never have shipped.
 *
 * The link is only rendered for an http(s) address. The URL comes from a provider's response and
 * is stored as text; anything else would be an `href` we did not mean to write.
 */
export function DeliveryStatus({
  attachment,
  repository,
  unshipped = false,
}: {
  attachment: TaskRepositoryDto;
  /** The attached Repository; undefined while the list is loading or if it is gone. */
  repository: Pick<RepositoryDto, "source" | "changeRequestNoun"> | undefined;
  /** The Task's latest approval committed here and could not ship (`delivery_failed`). */
  unshipped?: boolean;
}) {
  const noun = repository?.changeRequestNoun ?? null;
  const url = attachment.changeRequestUrl;
  if (url && /^https?:\/\//i.test(url)) {
    const label = noun ? noun.charAt(0).toUpperCase() + noun.slice(1) : "Request";
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 font-sans text-foreground underline underline-offset-2 hover:text-primary"
      >
        {attachment.changeRequestNumber
          ? `${label} #${attachment.changeRequestNumber}`
          : `Open the ${noun ?? "request"}`}
        <ExternalLink aria-hidden className="size-3" />
      </a>
    );
  }
  if (!attachment.resultBranch) return null;
  if (repository && noun === null) {
    return (
      <span className="font-sans text-muted-foreground">
        {repository.source === "local_path"
          ? "Committed locally — not pushed (no remote)"
          : "Committed locally — not pushed (not connected to a provider)"}
      </span>
    );
  }
  if (unshipped && noun) {
    return (
      <span className="font-sans text-feedback-error">
        Not shipped — committed here, not pushed or no {noun} opened
      </span>
    );
  }
  return (
    <span className="font-sans text-muted-foreground">Committed on this machine — not pushed</span>
  );
}
