/**
 * Claude Code integration (task TASK-014). The CLI's headless stream-JSON mode, wrapped so the
 * orchestrator can drive a run, follow it live, and learn which worktree it is happening in.
 */
export {
  type ClaudeUpdate,
  encodeUserTurn,
  type InitEvent,
  parseStreamLine,
  type ResultEvent,
  type StreamEvent,
  toUpdates,
} from "./events.js";
export {
  buildArgs,
  type ClaudeOutcome,
  type ClaudeSession,
  type ClaudeSessionOptions,
  startClaudeSession,
} from "./session.js";
