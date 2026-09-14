"use client";

import type { SessionDto, TaskDto } from "@solow/contracts";
import { Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { WHOLE_PAGE } from "@/lib/paged";
import { relativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * Everything about a Task that is true but not urgent, as a list in the page's rail.
 *
 * Which Harness Profile ran it, on which Executor, from which base ref, since when, under which
 * Session — the DTO carries all of it and for a long time the page named none of it, so an
 * operator comparing two runs had to go to Settings to learn which profile either used. It sat
 * behind an "About this task" popover after that; now the rail has a column for exactly this
 * kind of fact, and a popover in a column is a door in a hallway.
 *
 * The two profile lists are fetched when the list mounts. Both are already in React Query's
 * cache on any page that has shown a picker, so the usual cost is nothing.
 */
export function TaskMetaList({ task, session }: { task: TaskDto; session: SessionDto | null }) {
  const agents = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE });
  const executors = trpc.profile.executor.list.useQuery({ ...WHOLE_PAGE });
  const agent = agents.data?.items.find((p) => p.id === task.agentProfileId);
  const executor = executors.data?.items.find((p) => p.id === task.executorProfileId);
  // "—" while a list is still on its way; the id when the list arrived and the profile is gone.
  const nameOr = (loaded: boolean, name: string | undefined, id: string) =>
    name ?? (loaded ? id : "—");

  return (
    <dl className="space-y-2 text-xs">
      <Row label="Harness">
        {nameOr(agents.isSuccess, agent?.name, task.agentProfileId)}
        {agent?.model ? <Muted> · {agent.model}</Muted> : null}
      </Row>
      <Row label="Executor">
        {nameOr(executors.isSuccess, executor?.name, task.executorProfileId)}
        {executor ? <Muted> · {executor.kind}</Muted> : null}
      </Row>
      {session ? (
        <Row label="Session">
          <Id value={session.id} />
          <Muted>
            {" "}
            · started {relativeAge(session.startedAt)}
            {session.endedAt ? `, ended ${relativeAge(session.endedAt)}` : ", still open"}
          </Muted>
        </Row>
      ) : null}
      <Row label="Task">
        <Id value={task.id} />
      </Row>
      <Row label="Created">
        {relativeAge(task.createdAt)}
        <Muted> · updated {relativeAge(task.updatedAt)}</Muted>
      </Row>
    </dl>
  );
}

/** The Task's attachments: each repository's branch, from which base, and which one is primary. */
export function TaskRepositories({ task }: { task: TaskDto }) {
  const attachments = [...task.repositories].sort((a, b) => a.position - b.position);
  if (attachments.length === 0) {
    return <p className="text-muted-foreground text-xs">No repository attached.</p>;
  }
  return (
    <ul className="space-y-1 font-mono text-xs">
      {attachments.map((attachment, index) => (
        <li key={attachment.id} className="min-w-0 break-words">
          <span className="text-foreground">
            {attachment.resultBranch ?? attachment.checkoutBranch}
          </span>
          <Muted>
            {" "}
            from {attachment.baseRef ?? "HEAD"}
            {index === 0 && attachments.length > 1 ? " · primary" : ""}
          </Muted>
        </li>
      ))}
    </ul>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** An id, and the one thing anyone does with an id. */
function Id({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full items-center gap-1 font-mono">
      <span className="truncate">{value}</span>
      <button
        type="button"
        aria-label={`Copy ${value}`}
        // 24px to hit, 12px to see: the glyph stays small, the target does not.
        className={cn(
          "-my-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          copied && "text-feedback-ok",
        )}
        onClick={() => {
          // Best-effort: a clipboard write can be refused (an insecure origin, a denied
          // permission), and the id is on screen either way.
          void navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => {});
        }}
      >
        <Copy aria-hidden className="size-3" />
      </button>
    </span>
  );
}
