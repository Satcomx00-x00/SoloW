import type { TaskRepositoryDto } from "@solow/contracts";
import { ExternalLink } from "lucide-react";

/**
 * Where an approved branch ended up, for one attachment (A1).
 *
 * Its own component so the Task page takes one line to show it. Three honest states, and the
 * third is the one the old behaviour hid: a pull request (a link), a branch committed on this
 * machine only (said in words, so nobody assumes it was pushed), and nothing yet (not approved).
 *
 * The link is only rendered for an http(s) address. The URL comes from a provider's response and
 * is stored as text; anything else would be an `href` we did not mean to write.
 */
export function DeliveryStatus({ attachment }: { attachment: TaskRepositoryDto }) {
  const url = attachment.changeRequestUrl;
  if (url && /^https?:\/\//i.test(url)) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 font-sans text-foreground underline underline-offset-2 hover:text-primary"
      >
        {attachment.changeRequestNumber
          ? `Pull request #${attachment.changeRequestNumber}`
          : "Open the pull request"}
        <ExternalLink aria-hidden className="size-3" />
      </a>
    );
  }
  if (attachment.resultBranch) {
    return (
      <span className="font-sans text-muted-foreground">
        Committed locally — not pushed (no remote)
      </span>
    );
  }
  return null;
}
