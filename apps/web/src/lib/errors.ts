import {
  BillingErrorCode,
  CommonErrorCode,
  ExecutorProfileErrorCode,
  ExplainErrorCode,
  HarnessCatalogErrorCode,
  HarnessConfigErrorCode,
  HarnessLibraryErrorCode,
  HarnessProfileErrorCode,
  IntegrationErrorCode,
  IssueErrorCode,
  ProjectErrorCode,
  RepositoryErrorCode,
  ReviewErrorCode,
  SecretErrorCode,
  SessionErrorCode,
  TaskDependencyErrorCode,
  TaskErrorCode,
  TaskParentErrorCode,
  WidgetErrorCode,
  WorkflowErrorCode,
} from "@solow/contracts";

/**
 * Every failure the app shows, as a sentence that says what happened and what to do next.
 *
 * The server answers a refusal with a bare wire code in `TRPCError.message` (`unwrap` in
 * `server/trpc.ts`), and anything it did not anticipate — a driver error, a Zod rejection, a
 * dropped connection — arrives as whatever text the thrower chose. Rendering `error.message`
 * therefore shows either `WORKFLOW_IN_USE` or a JSON dump of Zod issues, and neither tells the
 * Owner what to do. So nothing on screen reads `error.message` directly any more: it comes through
 * here, and anything not recognised becomes a generic sentence rather than leaking a new code the
 * next time one is added.
 *
 * The wording never names a page ("reload the board"), because the same code reaches several
 * surfaces and the action has to be available on all of them.
 */
const MESSAGES: Record<string, string> = {
  [CommonErrorCode.Unauthorized]: "You have been signed out. Sign in again, then try once more.",
  [CommonErrorCode.Forbidden]:
    "This account is not allowed to do that. Sign in as this workspace's owner, then try again.",
  [CommonErrorCode.NotFound]:
    "That no longer exists — it may have been deleted. Reload the page to see what is there now.",
  [CommonErrorCode.ValidationFailed]:
    "Something in what you entered isn't valid. Check the fields, then try again.",
  [CommonErrorCode.FlagDisabled]:
    "This feature is turned off for this workspace. Turn it on in Settings → Feature flags.",
  [CommonErrorCode.RateLimited]: "Too many requests in a row. Wait a moment and try again.",

  [TaskDependencyErrorCode.Blocked]:
    "Can't start this task yet — it is waiting on a task that isn't done.",
  [TaskDependencyErrorCode.Cycle]:
    "That would make these tasks wait on each other in a loop. Remove one of the links first.",
  [TaskParentErrorCode.Cycle]:
    "That would make the task a sub-task of itself. Choose a different parent.",
  [TaskErrorCode.ConcurrencyCapReached]:
    "This harness profile is already running as many tasks as it allows. Wait for one to finish, or delete a task that is stuck.",
  [TaskErrorCode.NotReady]: "This task isn't ready to start. Move it to Ready first.",
  [TaskErrorCode.IllegalTransition]: "That move isn't allowed from this task's current state.",
  [TaskErrorCode.RepositoryUnreachable]:
    "The task's repository could not be reached. Check the repository is still connected in Settings.",
  [TaskErrorCode.HarnessUnavailable]:
    "The harness for this task is unavailable. Check its harness profile in Settings.",
  [TaskErrorCode.StillRunning]:
    "A harness is still running on this task and could not be stopped, so nothing was deleted.",
  [TaskErrorCode.StopFailed]:
    "The harness could not be stopped, so nothing was deleted. Check the orchestrator is running, then try again.",
  [TaskErrorCode.NotComplete]:
    "The harness hasn't said this task is finished, so there is nothing to review yet. Wait for the run to finish.",
  [TaskErrorCode.RetentionExpired]:
    "This task left History — its retention window passed and its record is gone. It cannot be restored.",
  [TaskErrorCode.NotDeleted]: "This task is not in History, so there is nothing to restore.",
  [TaskErrorCode.HasDependents]:
    "Other tasks are waiting on this one. Deleting it would unblock them.",
  [TaskErrorCode.AwaitingReview]:
    "This task is waiting for your review. Approve, request changes or reject it from the gate.",
  [TaskErrorCode.AlreadyStarted]: "This task has just been started. The page has been refreshed.",
  [TaskErrorCode.QuickNeedsRepository]: "Choose which repository the agent should work in.",
  [TaskErrorCode.QuickNeedsProfiles]:
    "Add a harness profile and an executor profile in Settings before starting a task.",
  [TaskErrorCode.NotUndelivered]:
    "This task is no longer waiting to be shipped. The page has been refreshed.",
  [TaskErrorCode.NoOrchestrator]:
    "The orchestrator is not running or did not take the request. Start the stack, then try again.",

  [BillingErrorCode.MissingCredential]:
    "This harness profile has no credential set. Add one in Settings before launching.",
  [BillingErrorCode.CredentialExpired]:
    "The harness's credential was rejected. Update it in Settings, then try again.",
  [BillingErrorCode.QuotaExhausted]:
    "The harness's quota is exhausted. Wait for it to reset, or give the profile another credential in Settings.",

  [ReviewErrorCode.NotInReview]:
    "This task is no longer waiting for a review, so nothing was decided. The page has been refreshed; decide again once the gate opens.",
  [ReviewErrorCode.NoOrchestrator]:
    "No orchestrator is running, so this decision cannot be applied. Start the stack, then decide again. Reject still works.",
  [ReviewErrorCode.AlreadyDecided]:
    "This review has already been decided. Reload the page to see the decision.",

  [IntegrationErrorCode.AuthenticationFailed]:
    "The provider rejected that token. Check it is correct and has the access SoloW needs, then connect again.",
  [IntegrationErrorCode.NotLinked]:
    "This repository is not linked to a connected integration, so there is nothing to sync from. Connect one in Settings → Integrations.",
  [IntegrationErrorCode.ProviderUnavailable]:
    "This version of SoloW cannot talk to this integration's provider. Update SoloW, or remove the integration.",
  [IntegrationErrorCode.CapabilityUnavailable]:
    "This integration's provider doesn't support that. Do it on the provider's own site instead.",

  [ProjectErrorCode.NotLocal]:
    "This project mirrors one on the provider, so its repositories are managed there. Change them on the provider.",
  [ProjectErrorCode.RepositoryAlreadyAttached]:
    "That repository is already attached to this project. Nothing needed changing.",

  [IssueErrorCode.HasTasks]:
    "This issue still has tasks. Move or delete them first, then delete the issue.",
  [IssueErrorCode.SourceOwned]:
    "This issue's title and description belong to its provider. Edit them there; the change arrives on the next sync.",
  [IssueErrorCode.HasRunningTasks]:
    "A task under this issue is still running. Stop it first, then delete the issue.",
  [IssueErrorCode.StopFailed]:
    "The issue's running tasks could not be stopped, so nothing was deleted. Check the orchestrator is running, then try again.",
  [IssueErrorCode.HasActiveTasks]:
    "This issue still has tasks in progress. Finish or stop them first, or close it anyway.",

  [SecretErrorCode.InUse]:
    "An integration or a harness profile still uses this secret. Point it at another secret first, then delete this one.",
  [HarnessProfileErrorCode.InUse]:
    "A task or a workflow step still uses this harness profile. Move it to another profile first, then delete this one.",
  [RepositoryErrorCode.InUse]:
    "Projects, issues or tasks still use this repository. Detach or delete them first, then disconnect it.",
  [ExecutorProfileErrorCode.InUse]:
    "A task or a workflow step still uses this executor profile. Move it to another profile first, then delete this one.",
  [HarnessCatalogErrorCode.KeyTaken]:
    "A harness with that key already exists. Choose a different key.",

  [ExplainErrorCode.NoCredential]:
    "This task's harness profile has no usable credential. Add one in Settings, then ask again.",
  [ExplainErrorCode.Upstream]: "The harness could not answer. Try again in a moment.",

  [SessionErrorCode.CursorStale]:
    "The run's history changed since this page loaded. Reload the page, then try again.",
  [WidgetErrorCode.NotPending]:
    "That question was already answered, or the run has moved on. Nothing more is needed.",
  [WidgetErrorCode.OptionUnknown]:
    "That answer isn't one the harness offered. Pick one of the listed choices.",

  [HarnessConfigErrorCode.NameTaken]:
    "A harness config with that name already exists. Choose a different name.",
  [HarnessConfigErrorCode.InUse]:
    "A harness profile still uses this config. Point it at another config first, then delete this one.",
  [HarnessConfigErrorCode.HarnessMismatch]:
    "That config is for a different harness than this profile runs. Choose a config for the same harness.",

  [HarnessLibraryErrorCode.NameTaken]:
    "Another item in the library already has that name. Choose a different name.",
  [HarnessLibraryErrorCode.InUse]:
    "A workflow step still uses this item. Remove it from the step first, then delete it.",
  [HarnessLibraryErrorCode.NotInWorkspace]:
    "That item, or a secret it uses, isn't in this workspace. Reload the page and choose again.",
  [HarnessLibraryErrorCode.SecretMissing]:
    "A secret this MCP server uses has been deleted. Choose another secret for it.",
  [HarnessLibraryErrorCode.ImportSourceNotFound]:
    "That folder doesn't exist, or isn't a folder. Check the path and try again.",
  [HarnessLibraryErrorCode.ImportCloneFailed]:
    "That repository could not be downloaded. Check the URL and that its host is reachable, then try again.",
  [HarnessLibraryErrorCode.ImportArchiveInvalid]:
    "That file isn't a zip archive SoloW can unpack. Choose a .zip of skill folders.",
  [HarnessLibraryErrorCode.ImportLocatorInvalid]:
    "SoloW can't import from that. Enter a folder path, owner/repo, a repository URL, a download link or an install command.",

  [WorkflowErrorCode.Empty]: "This workflow has no steps yet. Add a step before using it.",
  [WorkflowErrorCode.StepNotInWorkflow]:
    "That step is no longer in this workflow. Reload the page to see its current steps.",
  [WorkflowErrorCode.StaleOrder]:
    "The steps were reordered somewhere else first. Reload the page, then make the move again.",
  [WorkflowErrorCode.StepInUse]:
    "A task is still on this step. Finish it, or move it off the workflow, then delete the step.",
  [WorkflowErrorCode.InUse]:
    "A task is still on this workflow. Finish it, or move it off the workflow from its launch dialog, then delete.",
  [WorkflowErrorCode.TaskAlreadyStarted]:
    "This task has already started, so its workflow can't change now. Start a new task to use another workflow.",
  [WorkflowErrorCode.TaskNotOnWorkflow]:
    "This task doesn't follow a workflow, so there is no step to move to.",
  [WorkflowErrorCode.TaskWorkflowInProgress]:
    "This task is already partway through its workflow, and changing it would discard that work. Nothing was changed.",
  [WorkflowErrorCode.StaleCursor]:
    "The task moved on to another step in the meantime. Reload the page to see where it is.",
  [WorkflowErrorCode.BranchTargetIsSelf]:
    "A branch can't lead back to its own step. Choose another step for it to go to.",
  [WorkflowErrorCode.StepBranchedTo]:
    "Another step's branch still leads here. Point that branch elsewhere first, then delete this step.",
  [WorkflowErrorCode.GraphInvalid]:
    "This workflow has a step nothing leads to, or one that can never reach the end. Fix the steps marked on the canvas first.",
  [WorkflowErrorCode.ToolNotInWorkspace]:
    "A step uses an MCP server or a skill that isn't in this workspace. Choose one from this workspace's library.",
  [WorkflowErrorCode.NoHarnessProfile]:
    "This workspace has no harness profile for the imported steps to run on. Add one in Settings, then import again.",
};

/** What an unrecognised failure says. Deliberately vague: guessing a cause would mislead. */
export const GENERIC_ERROR = "That didn't work. Try again, or reload the page.";

const UNREACHABLE =
  "Could not reach SoloW. Check it is still running and this machine is online, then try again.";
const SERVER_FAULT =
  "Something went wrong on the SoloW server. Try again; if it keeps happening, check the server log.";
const INVALID_INPUT = MESSAGES[CommonErrorCode.ValidationFailed] as string;

/**
 * The browser's `fetch` rejects with a different sentence in each engine (Chromium, Firefox,
 * WebKit). Only consulted when the error carries no tRPC code: one that does came back from the
 * server, so whatever it says about a network was the server's own outbound call failing.
 */
const NETWORK_FAILURE = /failed to fetch|networkerror|load failed|network request failed/i;

/** A wire code, optionally followed by detail the server appended after a colon. */
const WIRE_CODE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{4,})(?::|$)/;

/**
 * A source-control provider's refusal, as `@solow/scm` words it (`<provider> <verb> to <url>
 * failed: <status> <body>`). A driver throw is not a Result, so it reaches the client as an
 * INTERNAL_SERVER_ERROR carrying that text — the URL and a truncated JSON body included.
 */
const PROVIDER_FAILURE = /^(github|gitlab|gitea)\b.*?(?:failed: (\d{3})|GraphQL error)/i;
const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
};

/** The status line of a provider refusal, as the next step it calls for. */
function describeProviderFailure(message: string): string | null {
  const match = PROVIDER_FAILURE.exec(message);
  if (!match) return null;
  const name = PROVIDER_NAMES[(match[1] ?? "").toLowerCase()] ?? "The provider";
  const status = match[2] ? Number(match[2]) : null;
  if (status === 429) {
    return `${name} is limiting requests from SoloW. Wait a minute, then try again.`;
  }
  if (status !== null && status >= 500) {
    return `${name} is having trouble right now. Try again in a few minutes.`;
  }
  // On a refusal the provider's own one-line reason is worth keeping — "Resource not accessible
  // by personal access token" says which permission is missing. The URL and the rest of the JSON
  // body around it are noise, so only that line is lifted out.
  const reason =
    /"message"\s*:\s*"([^"]{1,160})"/.exec(message)?.[1] ??
    /GraphQL error: (.{1,160})$/.exec(message)?.[1];
  const said = reason ? ` (“${reason.trim()}”)` : "";
  if (status === 401 || status === 403) {
    return `${name} refused SoloW's credential${said}. Check the integration's token in Settings has access to this, then try again.`;
  }
  if (status === 404) {
    return `${name} could not find that${said} — it may have been deleted or moved there. Reload the page, then try again.`;
  }
  // A 400/422, or a GraphQL error: the provider rejecting what was sent — a label or an assignee
  // it does not know.
  return `${name} rejected the request${said}. Check what you entered, then try again.`;
}

interface ErrorLike {
  message?: unknown;
  data?: { code?: unknown } | null;
}

/** The wire code a failure carries, or null — for callers that branch on one before describing it. */
export function errorCode(error: unknown): string | null {
  const message = messageOf(error);
  return message ? (WIRE_CODE.exec(message)?.[1] ?? null) : null;
}

function messageOf(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as ErrorLike).message;
    if (typeof message === "string") return message;
  }
  return null;
}

/** tRPC's own code (`NOT_FOUND`, `INTERNAL_SERVER_ERROR`…), present even when the message is raw text. */
function transportCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as ErrorLike).data?.code;
  return typeof code === "string" ? code : null;
}

/** Zod's rejection arrives as its issue list serialised into the message. */
function isZodIssueList(message: string): boolean {
  if (!message.startsWith("[")) return false;
  try {
    const parsed: unknown = JSON.parse(message);
    return Array.isArray(parsed) && parsed.every((i) => i && typeof i === "object" && "path" in i);
  } catch {
    return false;
  }
}

/**
 * A sentence for any failure: a tRPC error, an `Error`, a bare wire code, or nothing.
 *
 * `overrides` lets a surface say a code more precisely than the shared table can — the Task page
 * knows the thing that is `NOT_FOUND` is a task. It is consulted first, by wire code.
 */
export function describeError(
  error: unknown,
  overrides?: Readonly<Partial<Record<string, string>>>,
): string {
  const message = messageOf(error)?.trim() ?? "";
  const code = errorCode(message);
  if (code) {
    const known = overrides?.[code] ?? MESSAGES[code];
    if (known) return known;
  }
  if (message && isZodIssueList(message)) return INVALID_INPUT;
  if (message && !transportCode(error) && NETWORK_FAILURE.test(message)) return UNREACHABLE;
  const provider = message ? describeProviderFailure(message) : null;
  if (provider) return provider;

  // The message was raw text, or a code nothing here knows. tRPC's own classification still says
  // which kind of failure it was, and that is enough to point at the right next step.
  const transport = transportCode(error);
  if (transport) {
    const known = overrides?.[transport] ?? MESSAGES[transport];
    if (known) return known;
    // Not for an unknown wire code: `unwrap` sends every unmapped code as BAD_REQUEST, and most of
    // those are refusals of the action, not of what was typed.
    if (!code && (transport === "BAD_REQUEST" || transport === "PARSE_ERROR")) return INVALID_INPUT;
    if (transport === "INTERNAL_SERVER_ERROR") return SERVER_FAULT;
  }
  return GENERIC_ERROR;
}

/** `describeError` for an optional failure: `null` in, `null` out, so JSX can guard on it. */
export function describeOptionalError(
  error: unknown,
  overrides?: Readonly<Partial<Record<string, string>>>,
): string | null {
  if (error === null || error === undefined || error === "") return null;
  return describeError(error, overrides);
}
