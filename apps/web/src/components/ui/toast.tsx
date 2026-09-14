"use client";

import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

/**
 * The app's transient surface — the one it did not have.
 *
 * Every failure on the Task page used to land as a permanent inline line: a send the hub refused,
 * a move the server declined, a delete that did not go — all shaped the same, none dismissable,
 * all sitting there until the *next* mutation happened to clear them. A notification is a system
 * of four volumes (toast, banner, modal, badge) and this is the quiet one: for things that are
 * true for a moment and need no answer, or that offer one action — Undo — for a few seconds.
 *
 * The rules, so every toast behaves the same: bottom-right on a desktop, the top edge on a phone
 * (a thumb cannot read what a keyboard covers); at most three on screen, the rest queued rather
 * than piled; the timer pauses while the pointer is over the stack so a person can finish
 * reading; a close button always, and a tone carried by an icon and a left accent as well as a
 * colour. Dismissal is by severity — routine notes go in ~4s, cautions hold ~7s, an error waits
 * to be acknowledged — because a message that vanished while you looked away and a message that
 * would not go away are the two ways a toast trains people to stop reading toasts.
 *
 * No dependency: a hundred lines here against a library whose defaults would have to be argued
 * with one by one.
 */

export type ToastTone = "info" | "ok" | "caution" | "error";

export interface ToastInput {
  title: string;
  description?: string | undefined;
  tone?: ToastTone | undefined;
  /** One action, on the toast — "Undo", "Retry". The toast closes when it is pressed. */
  action?: { label: string; onClick: () => void } | undefined;
  /** Milliseconds on screen; `null` holds until dismissed. Defaults by tone (see `HOLD`). */
  duration?: number | null | undefined;
}

interface ToastRecord extends ToastInput {
  id: number;
  tone: ToastTone;
  duration: number | null;
}

interface ToastApi {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

const HOLD: Record<ToastTone, number | null> = {
  info: 4000,
  ok: 4000,
  caution: 7000,
  error: null,
};

const ICON: Record<ToastTone, typeof Info> = {
  info: Info,
  ok: CircleCheck,
  caution: TriangleAlert,
  error: CircleAlert,
};

const ACCENT: Record<ToastTone, string> = {
  info: "border-l-ring text-muted-foreground",
  ok: "border-l-feedback-ok text-feedback-ok",
  caution: "border-l-feedback-caution text-feedback-caution",
  error: "border-l-feedback-error text-feedback-error",
};

const VISIBLE = 3;

const ToastContext = createContext<ToastApi | null>(null);

/** The stack's state and its viewport; mount once, above everything that may toast. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);
  const toast = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    const tone = input.tone ?? "info";
    setToasts((all) => [
      ...all,
      { ...input, id, tone, duration: input.duration === undefined ? HOLD[tone] : input.duration },
    ]);
    return id;
  }, []);
  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts.slice(0, VISIBLE)} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/** `toast(...)` and `dismiss(id)`. Throws outside the provider, so a missing mount is loud. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used within <ToastProvider>");
  return api;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastRecord[];
  onDismiss: (id: number) => void;
}) {
  const [paused, setPaused] = useState(false);
  if (toasts.length === 0) return null;
  return (
    <section
      aria-label="Notifications"
      data-toast-viewport
      className={cn(
        "pointer-events-none fixed inset-x-4 top-4 z-50 flex flex-col gap-2",
        "sm:inset-x-auto sm:top-auto sm:right-4 sm:bottom-4 sm:w-[360px]",
        paused && "toast-paused",
      )}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} paused={paused} onDismiss={() => onDismiss(t.id)} />
      ))}
    </section>
  );
}

function ToastCard({
  toast,
  paused,
  onDismiss,
}: {
  toast: ToastRecord;
  paused: boolean;
  onDismiss: () => void;
}) {
  const Icon = ICON[toast.tone];
  const [leaving, setLeaving] = useState(false);
  // What is left of the timer, carried across pauses: hovering stops the clock, leaving restarts
  // it from where it stopped, so a pause never buys a second full lifetime.
  const remaining = useRef(toast.duration);
  const startedAt = useRef<number | null>(null);

  const close = useCallback(() => {
    setLeaving(true);
    // The exit animation's length; the record goes once it has played.
    setTimeout(onDismiss, 150);
  }, [onDismiss]);

  useEffect(() => {
    if (remaining.current === null || leaving) return;
    if (paused) {
      if (startedAt.current !== null) {
        remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
        startedAt.current = null;
      }
      return;
    }
    startedAt.current = Date.now();
    const handle = setTimeout(close, remaining.current);
    return () => clearTimeout(handle);
  }, [paused, leaving, close]);

  const ring = toast.action && toast.duration !== null;

  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      data-toast={toast.tone}
      className={cn(
        "surface-edge pointer-events-auto flex items-start gap-2.5 rounded-lg border border-l-2 bg-popover p-3 text-popover-foreground text-sm shadow-lg",
        leaving ? "toast-leave" : "toast-enter",
        ACCENT[toast.tone],
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-foreground">
        <p className="font-medium">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
            {toast.description}
          </p>
        ) : null}
      </div>
      {toast.action ? (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            close();
          }}
          className="relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 font-medium text-foreground text-xs transition-colors duration-100 hover:bg-accent"
        >
          {ring ? (
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-3.5 -rotate-90"
              style={{
                // Circumference of r=6, and the lifetime the ring drains over.
                ["--toast-ring" as string]: "37.7",
                ["--toast-duration" as string]: `${toast.duration}ms`,
              }}
            >
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="toast-ring"
              />
            </svg>
          ) : null}
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={close}
        className="-m-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
