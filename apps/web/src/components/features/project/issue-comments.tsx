"use client";

import type { IssueCommentDto } from "@solow/contracts";
import { Loader2, MessageSquare, Send } from "lucide-react";
import { useState } from "react";
import { AgentMarkdown } from "@/components/features/task/markdown";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { relativeAge } from "@/lib/relative-time";
import { trpc } from "@/trpc/react";

/**
 * The discussion on an issue, and the box to add to it.
 *
 * Read **live** and never mirrored: a comment thread is the one part of an issue that changes
 * without anything here doing it, and a stale copy of a conversation is worse than no copy — it
 * looks like the whole of it.
 *
 * The body is Markdown rendered by the same component that draws the issue body two inches above,
 * so a code fence in a comment looks like a code fence and not like a line of backticks. The raw
 * text is what travels; a provider's own HTML would have to be trusted or sanitised, and neither
 * is worth doing for something we can render ourselves.
 */

function Comment({ comment }: { comment: IssueCommentDto }) {
  const login = comment.author?.login ?? "unknown";
  return (
    <article className="rounded-lg border bg-card/40">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Avatar className="size-5 shrink-0">
          {comment.author?.avatarUrl ? <AvatarImage src={comment.author.avatarUrl} alt="" /> : null}
          <AvatarFallback className="text-[9px] uppercase">{login.slice(0, 2)}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 truncate font-medium text-xs">
          {comment.author?.name ?? login}
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {relativeAge(comment.createdAt)}
        </span>
        {comment.updatedAt && (
          // Only when there was one: GitHub stamps `updated_at` on every comment, and passing that
          // through would mark the whole thread as edited.
          <span className="shrink-0 text-2xs text-muted-foreground/60">· edited</span>
        )}
        {comment.url && (
          <a
            href={comment.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto shrink-0 text-2xs text-muted-foreground hover:text-foreground hover:underline"
          >
            View
          </a>
        )}
      </header>
      <div className="px-4 py-3">
        <AgentMarkdown text={comment.body} />
      </div>
    </article>
  );
}

export function IssueComments({ issueId }: { issueId: string }) {
  const utils = trpc.useUtils();
  const thread = trpc.issue.comments.useQuery({ issueId });
  const [draft, setDraft] = useState("");

  const post = trpc.issue.comment.useMutation({
    onSuccess: () => {
      // Cleared only once the provider has it. Clearing on submit loses what someone wrote the
      // moment a token expires — and they were the only copy.
      setDraft("");
      void utils.issue.comments.invalidate({ issueId });
    },
  });

  if (thread.isPending) {
    return (
      <section className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </section>
    );
  }

  const comments = thread.data?.comments ?? [];

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 font-medium text-2xs text-muted-foreground">
        <MessageSquare aria-hidden className="size-3.5" />
        Comments
        <span className="ml-auto font-normal">{comments.length}</span>
      </h3>

      {comments.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">No comments yet.</p>
      ) : (
        <div className="space-y-2">
          {comments.map((comment) => (
            <Comment key={comment.externalId} comment={comment} />
          ))}
        </div>
      )}

      {thread.data?.canComment && (
        <Tabs defaultValue="write" className="gap-2">
          {/* Write and Preview, because a comment is Markdown and the only way to know what a
              table or a checklist will look like is to look at it before posting. */}
          <TabsList className="h-7">
            <TabsTrigger value="write" className="text-2xs">
              Write
            </TabsTrigger>
            <TabsTrigger value="preview" className="text-2xs">
              Preview
            </TabsTrigger>
          </TabsList>

          <TabsContent value="write">
            <Textarea
              rows={4}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Leave a comment. Markdown is supported."
              className="text-xs"
            />
          </TabsContent>

          <TabsContent value="preview">
            <div className="min-h-[92px] rounded-lg border bg-card/40 px-4 py-3">
              {draft.trim() ? (
                <AgentMarkdown text={draft} />
              ) : (
                <p className="text-muted-foreground text-xs italic">Nothing to preview yet.</p>
              )}
            </div>
          </TabsContent>

          <div className="flex items-center justify-between gap-2">
            {post.error ? (
              // The provider's own refusal — "you do not have write access" is a different problem
              // from "the network is down", and only one of them is worth retrying.
              <p className="min-w-0 flex-1 truncate text-2xs text-state-failed">
                {post.error.message}
              </p>
            ) : (
              <span />
            )}
            <Button
              size="xs"
              disabled={!draft.trim() || post.isPending}
              onClick={() => post.mutate({ issueId, body: draft })}
            >
              {post.isPending ? (
                <Loader2 aria-hidden className="animate-spin" />
              ) : (
                <Send aria-hidden />
              )}
              Comment
            </Button>
          </div>
        </Tabs>
      )}
    </section>
  );
}
