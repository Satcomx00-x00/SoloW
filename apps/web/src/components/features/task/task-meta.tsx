"use client";

import type { SessionDto, TaskDto } from "@solow/contracts";
import { Copy, Info } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WHOLE_PAGE } from "@/lib/paged";
import { relativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * Everything about a Task that is true but not urgent, behind one button in the header.
 *
 * Which Harness Profile ran it, on which Executor, from which base ref, since when, under which
 * Session — the DTO carries all of it and the page named none of it, so an operator comparing
 * two runs had to go to Settings to learn which profile either used. It stays out of the header
 * proper because none of it is the subject: the header has room for the title, the state and
 * the branch, and a fourth line of ids is what makes people stop reading the first three.
 *
 * The profile lists are fetched only once the popover opens. Both are already in React Query's
 * cache on any page that has shown a picker, so the usual cost is nothing.
 */
export function TaskMeta({ task, session }: { task: TaskDto; session: SessionDto | null }) {
  const [open, setOpen] = useState(false);
  const agents = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE }, { enabled: open });
  const executors = trpc.profile.executor.list.useQuery({ ...WHOLE_PAGE }, { enabled: open });
  const agent = agents.data?.items.find((p) => p.id === task.agentProfileId);
  const executor = executors.data?.items.find((p) => p.id === task.executorProfileId);
  // "—" while a list is still on its way; the id when the list arrived and the profile is gone.
  const nameOr = (loaded: boolean, name: string | undefined, id: string) =>
    name ?? (loaded ? id : "—");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label="About this task"
          className="text-muted-foreground"
          size="icon"
          title="About this task"
          variant="ghost"
        >
          <Info />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <PopoverHeader className="border-b px-3 py-2">
          <PopoverTitle className="text-sm">About this task</PopoverTitle>
          <PopoverDescription className="text-2xs">
            Created {relativeAge(task.createdAt)} · updated {relativeAge(task.updatedAt)}
          </PopoverDescription>
        </PopoverHeader>
        <dl className="space-y-2 px-3 py-2 text-xs">
          <Row label="Harness profile">
            {nameOr(agents.isSuccess, agent?.name, task.agentProfileId)}
            {agent?.model ? <Muted> · {agent.model}</Muted> : null}
          </Row>
          <Row label="Executor">
            {nameOr(executors.isSuccess, executor?.name, task.executorProfileId)}
            {executor ? <Muted> · {executor.kind}</Muted> : null}
          </Row>
          <Row label={task.repositories.length > 1 ? "Repositories" : "Repository"}>
            <ul className="space-y-1">
              {[...task.repositories]
                .sort((a, b) => a.position - b.position)
                .map((attachment, index) => (
                  <li key={attachment.id} className="font-mono">
                    <span className="text-foreground">
                      {attachment.resultBranch ?? attachment.checkoutBranch}
                    </span>
                    <Muted>
                      {" "}
                      from {attachment.baseRef ?? "HEAD"}
                      {index === 0 && task.repositories.length > 1 ? " · primary" : ""}
                    </Muted>
                  </li>
                ))}
            </ul>
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
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2">
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
    <span className="inline-flex items-center gap-1 font-mono">
      <span className="truncate">{value}</span>
      <button
        type="button"
        aria-label={`Copy ${value}`}
        className={cn(
          "inline-flex size-4 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground",
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
