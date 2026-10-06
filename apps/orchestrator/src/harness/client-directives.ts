import type { HarnessProtocol } from "@solow/contracts";

/**
 * Flags a catalog row lists for its harness that are really addressed to the harness's *client*.
 *
 * opencode's `--auto` ("auto-approve permissions that are not explicitly denied") is the case.
 * In opencode it is an option of its own client — the TUI and `opencode run` answer the server's
 * permission requests, and `--auto` tells them to answer yes. Under ACP, SoloW is that client:
 * `opencode acp` has no `--auto` and refuses to start with one ("Unrecognized flag: --auto in
 * command opencode acp", 2.0.22 and 2.0.24 alike). So the row may say `--auto` — it is the switch
 * an operator knows from opencode — and for an ACP launch SoloW takes it off the command line and
 * applies it itself: every permission request is answered at once with the narrowest allow the
 * harness offered, still published and logged as decided by policy, exactly as a Profile set to
 * never ask is.
 */
export const AUTO_APPROVE_FLAG = "--auto";

export interface ClientDirectives {
  /** The arguments the harness process is actually started with. */
  args: string[];
  /** Approve every permission the harness asks for, without waiting for a person. */
  autoApprove: boolean;
}

/** Split a catalog row's arguments into the process's and the client's. */
export function clientDirectives(
  protocol: HarnessProtocol,
  args: readonly string[] | null | undefined,
): ClientDirectives {
  const list = [...(args ?? [])];
  // Only ACP has a client of SoloW's own: a stream-json or passthrough CLI takes its flags itself.
  if (protocol !== "acp") return { args: list, autoApprove: false };
  return {
    args: list.filter((arg) => arg !== AUTO_APPROVE_FLAG),
    autoApprove: list.includes(AUTO_APPROVE_FLAG),
  };
}
