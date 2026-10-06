"use client";

import "@xterm/xterm/css/xterm.css";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * The Task's terminal, drawn by xterm.js: the Task's own conversation, mounted.
 *
 * When the Task has a Claude Code conversation and no run is holding it, the orchestrator starts
 * `claude --resume <it>` on a pseudo-terminal in the worktree — the harness's own TUI, the very
 * conversation the run had, under the run's home and credential — and what is said here is what
 * the next round resumes from. Otherwise it is a shell in the worktree, and the orchestrator says
 * why; reconnecting asks again, so a conversation a run was holding mounts once it stops. Bytes
 * travel over the `/terminal` socket (`apps/orchestrator/src/ws/terminal.ts`), authorised by the
 * same short-lived ticket as the Task's stream.
 *
 * One process per mount: the pane keeps it while it is hidden, and leaving the page hangs it up,
 * as closing a terminal window does.
 */
export type TerminalMode = { mode: "chat" } | { mode: "shell"; reason: string | null };

type Phase =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "exited"; code: number }
  | { kind: "failed"; message: string };

export function TaskTerminal({
  taskId,
  visible,
  onMode,
  inject = null,
}: {
  taskId: string;
  visible: boolean;
  /** What the orchestrator mounted, for the pane's header. */
  onMode?: ((mode: TerminalMode | null) => void) | undefined;
  /**
   * A line to type into the conversation once it is ready ("Chat about it"), never sent: the
   * person finishes it and presses Enter. A new `id` is a new line.
   */
  inject?: { id: number; text: string } | null;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [mode, setMode] = useState<TerminalMode | null>(null);
  const onModeRef = useRef(onMode);
  onModeRef.current = onMode;
  useEffect(() => onModeRef.current?.(mode), [mode]);
  // Bumped by "Start a new shell": the effect below keys on it.
  const [generation, setGeneration] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  /** When the terminal last drew something: a TUI still drawing is not ready to be typed into. */
  const lastOutput = useRef(0);
  const utils = trpc.useUtils();

  const requestUrl = useCallback(
    async (cols: number, rows: number) => {
      const { url } = await utils.client.stream.ticket.mutate({ taskId });
      const terminalUrl = new URL(url);
      terminalUrl.pathname = "/terminal";
      terminalUrl.searchParams.set("cols", String(cols));
      terminalUrl.searchParams.set("rows", String(rows));
      return terminalUrl.toString();
    },
    [utils, taskId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is the restart trigger
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let observer: ResizeObserver | null = null;
    const encoder = new TextEncoder();

    void (async () => {
      // Loaded here, not at the top: xterm reaches for `window` as it loads, and this module is
      // also evaluated on the server.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;
      let terminal: Terminal;
      try {
        terminal = new Terminal({
          cursorBlink: true,
          fontFamily: monospaceFamily(element),
          fontSize: 13,
          scrollback: 5000,
          allowProposedApi: false,
          theme: themeFrom(element),
        });
      } catch {
        // No canvas, no fonts — a DOM stand-in, or a browser xterm cannot draw in.
        setPhase({ kind: "failed", message: "This browser cannot draw the terminal." });
        return;
      }
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      try {
        terminal.open(element);
      } catch {
        terminal.dispose();
        setPhase({ kind: "failed", message: "This browser cannot draw the terminal." });
        return;
      }
      term.current = terminal;
      fit.current = fitAddon;
      safeFit(fitAddon);

      setPhase({ kind: "connecting" });
      let url: string;
      try {
        url = await requestUrl(terminal.cols, terminal.rows);
      } catch {
        if (!disposed)
          setPhase({ kind: "failed", message: "Could not get a ticket for the terminal." });
        return;
      }
      if (disposed) return;
      let opened = false;
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        opened = true;
        setPhase({ kind: "open" });
        terminal.focus();
      };
      socketRef.current = socket;
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          lastOutput.current = Date.now();
          terminal.write(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        try {
          const message = JSON.parse(event.data) as {
            type?: string;
            code?: number;
            message?: string;
            mode?: string;
            reason?: string;
          };
          if (message.type === "mode")
            setMode(
              message.mode === "chat"
                ? { mode: "chat" }
                : { mode: "shell", reason: message.reason ?? null },
            );
          if (message.type === "exit") setPhase({ kind: "exited", code: message.code ?? 0 });
          if (message.type === "error")
            setPhase({ kind: "failed", message: message.message ?? "The terminal failed." });
        } catch {
          // Not a control message; nothing else is sent as text.
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setPhase((was) =>
          was.kind === "exited" || was.kind === "failed"
            ? was
            : opened
              ? { kind: "failed", message: "The connection to the terminal was lost." }
              : {
                  kind: "failed",
                  // The upgrade's refusal is not readable from a browser socket; these are the
                  // reasons it is refused (see `authorizeTerminal`).
                  message:
                    "No terminal could be opened. The task has no worktree yet — the first run creates it — or it runs in a container, whose files are not on this machine.",
                },
        );
      };
      terminal.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
      });
      terminal.onBinary((data) => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff;
        socket.send(bytes);
      });
      terminal.onResize(({ cols, rows }) => {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: "resize", cols, rows }));
      });
      observer = new ResizeObserver(() => safeFit(fitAddon));
      observer.observe(element);
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      socket?.close();
      term.current?.dispose();
      term.current = null;
      fit.current = null;
    };
  }, [requestUrl, generation]);

  /*
   * "Chat about it": type the line once the conversation's TUI is waiting for input — after it has
   * stopped drawing, and not while it shows its folder-trust or first-run screens, where a typed
   * character is an answer to a menu. Never into a shell: a sentence typed at a prompt is a
   * command. Abandoned after two minutes rather than typed into whatever is on screen by then.
   */
  const [injectNote, setInjectNote] = useState<string | null>(null);
  useEffect(() => {
    if (!inject) return;
    if (mode?.mode === "shell") {
      setInjectNote(
        "The task's conversation could not be mounted here, so there is nothing to chat in — see why above.",
      );
      return;
    }
    setInjectNote(null);
    const started = Date.now();
    const timer = setInterval(() => {
      const socket = socketRef.current;
      const terminal = term.current;
      if (Date.now() - started > 120_000) {
        clearInterval(timer);
        return;
      }
      if (!socket || socket.readyState !== WebSocket.OPEN || !terminal || mode?.mode !== "chat")
        return;
      if (lastOutput.current === 0 || Date.now() - lastOutput.current < 900) return;
      if (
        /trust this folder|Choose the text style|Press Enter to continue|Select login method/i.test(
          screenText(terminal),
        )
      )
        return;
      clearInterval(timer);
      socket.send(new TextEncoder().encode(inject.text));
      terminal.focus();
    }, 300);
    return () => clearInterval(timer);
  }, [inject, mode]);

  // Shown again: the pane had no size while hidden, so fit it to the one it has now.
  useEffect(() => {
    if (!visible || !fit.current) return;
    safeFit(fit.current);
    term.current?.focus();
  }, [visible]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--terminal,var(--background))]">
      {phase.kind === "exited" || phase.kind === "failed" ? (
        <div
          role="status"
          className={cn(
            "flex shrink-0 items-center gap-3 border-b px-3 py-2 text-xs",
            phase.kind === "failed" ? "text-feedback-error" : "text-muted-foreground",
          )}
        >
          <span className="min-w-0 flex-1">
            {phase.kind === "exited"
              ? mode?.mode === "chat"
                ? `The conversation was closed (code ${phase.code}).`
                : `The shell exited (code ${phase.code}).`
              : phase.message}
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setMode(null);
              setGeneration((n) => n + 1);
            }}
          >
            <RotateCcw aria-hidden /> Reconnect
          </Button>
        </div>
      ) : injectNote ? (
        <div role="status" className="shrink-0 border-b px-3 py-2 text-feedback-caution text-xs">
          {injectNote}
        </div>
      ) : mode?.mode === "shell" && mode.reason ? (
        // Why this is a shell and not the conversation — and the way to ask again.
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b px-3 py-2 text-muted-foreground text-xs"
          data-terminal-reason
        >
          <span className="min-w-0 flex-1">{mode.reason}</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setMode(null);
              setGeneration((n) => n + 1);
            }}
          >
            <RotateCcw aria-hidden /> Reconnect
          </Button>
        </div>
      ) : null}
      <div
        ref={host}
        className="min-h-0 flex-1 overflow-hidden px-2 py-1.5"
        data-task-terminal={phase.kind}
        data-terminal-mode={mode?.mode ?? "pending"}
      />
    </div>
  );
}

/** What the terminal shows right now, as text — to tell a menu from an input prompt. */
function screenText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = buffer.viewportY; i < buffer.viewportY + terminal.rows; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

/** Fitting a zero-sized element throws inside the addon; a hidden pane is exactly that. */
function safeFit(addon: FitAddon): void {
  try {
    addon.fit();
  } catch {
    // Fitted again when the pane is shown.
  }
}

function monospaceFamily(element: HTMLElement): string {
  const probe = document.createElement("span");
  probe.className = "font-mono";
  element.appendChild(probe);
  const family = getComputedStyle(probe).fontFamily;
  probe.remove();
  return family || "ui-monospace, Menlo, monospace";
}

/**
 * The page's own colours, for xterm — which parses hex and rgb, not the `oklch` the theme is
 * written in. A canvas does the conversion: whatever the browser can paint, it can read back.
 */
function themeFrom(element: HTMLElement): {
  background: string;
  foreground: string;
  cursor: string;
} {
  const style = getComputedStyle(element);
  const toRgb = (color: string, fallback: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) return fallback;
    context.fillStyle = fallback;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  };
  const background = toRgb(
    getComputedStyle(element.parentElement ?? element).backgroundColor,
    "#111111",
  );
  const foreground = toRgb(style.color, "#e5e5e5");
  return { background, foreground, cursor: foreground };
}
