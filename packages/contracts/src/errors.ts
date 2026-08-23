/**
 * Canonical error codes shared by the API surface and services.
 * `as const` literals so both sides narrow to the same union (plan §2).
 */

export const CommonErrorCode = {
  Unauthorized: "UNAUTHORIZED",
  Forbidden: "FORBIDDEN",
  NotFound: "NOT_FOUND",
  ValidationFailed: "VALIDATION_FAILED",
  FlagDisabled: "FLAG_DISABLED",
  RateLimited: "TOO_MANY_REQUESTS",
} as const;
export type CommonErrorCode = (typeof CommonErrorCode)[keyof typeof CommonErrorCode];

export const TaskErrorCode = {
  IllegalTransition: "TASK_ILLEGAL_TRANSITION",
  NotReady: "TASK_NOT_READY",
  ConcurrencyCapReached: "TASK_CONCURRENCY_CAP_REACHED",
  RepositoryUnreachable: "TASK_REPOSITORY_UNREACHABLE",
  AgentUnavailable: "TASK_AGENT_UNAVAILABLE",
  /**
   * Deleting is refused while other Tasks declare a `blocked_by` edge on this one. Dropping it
   * would silently start work the Owner gated behind it, so the cascade is opt-in via `force`.
   */
  HasDependents: "TASK_HAS_DEPENDENTS",
  /**
   * The delete reached the cascade with the Task still running. Same reasoning as
   * `IssueErrorCode.HasRunningTasks`: dropping the row mid-run orphans the agent process.
   */
  StillRunning: "TASK_STILL_RUNNING",
  /**
   * The Task's run could not be stopped, so nothing was deleted — see
   * `IssueErrorCode.StopFailed`, which this is the single-Task counterpart of.
   */
  StopFailed: "TASK_STOP_FAILED",
} as const;
export type TaskErrorCode = (typeof TaskErrorCode)[keyof typeof TaskErrorCode];

export const BillingErrorCode = {
  QuotaExhausted: "BILLING_QUOTA_EXHAUSTED",
  CredentialExpired: "BILLING_CREDENTIAL_EXPIRED",
  MissingCredential: "BILLING_MISSING_CREDENTIAL",
} as const;
export type BillingErrorCode = (typeof BillingErrorCode)[keyof typeof BillingErrorCode];

export const ReviewErrorCode = {
  NotInReview: "REVIEW_TASK_NOT_IN_REVIEW",
  AlreadyDecided: "REVIEW_ALREADY_DECIDED",
} as const;
export type ReviewErrorCode = (typeof ReviewErrorCode)[keyof typeof ReviewErrorCode];

export const IntegrationErrorCode = {
  /** The provider rejected the credential at connect time (issue #15 AC-1). */
  AuthenticationFailed: "INTEGRATION_AUTHENTICATION_FAILED",
  /** A Repository has no linked Integration to sync from. */
  NotLinked: "INTEGRATION_NOT_LINKED",
  /**
   * The Integration names a provider this build has no driver for — an orphan (F21 FR-7).
   *
   * Reachable because `integration.provider` stores an id rather than a member of a closed enum,
   * which is what lets a Workspace written by a build shipping a fourth provider still open in
   * one that does not. The row is readable; nothing can be done through it.
   */
  ProviderUnavailable: "INTEGRATION_PROVIDER_UNAVAILABLE",
  /**
   * The provider is installed and does not do this. Distinct from `ProviderUnavailable` on
   * purpose: "your Jira connection cannot list repositories" and "nothing here knows what Jira
   * is" are different problems with different fixes, and collapsing them would tell an Owner to
   * reinstall something that is working correctly.
   */
  CapabilityUnavailable: "INTEGRATION_CAPABILITY_UNAVAILABLE",
} as const;
export type IntegrationErrorCode = (typeof IntegrationErrorCode)[keyof typeof IntegrationErrorCode];

export const IssueErrorCode = {
  /**
   * Deleting an Issue is blocked while it has Tasks (spec F01 States & Rules) — `task.issue_id`
   * is a NOT NULL FK, so a cascade would take the Tasks with it. The user must move or remove
   * those Tasks first; this never cascades.
   */
  HasTasks: "ISSUE_HAS_TASKS",
  /** Title/description are the provider's own on an imported Issue (spec F01 FR-3) — refused here. */
  SourceOwned: "ISSUE_SOURCE_OWNED",
  /**
   * A force delete reached the cascade while a Task was still running. Distinct from `HasTasks`:
   * that one is the ordinary guard a force overrides, this one is the condition force must not
   * override, because dropping a `task` row mid-run leaves its agent process with nothing
   * referencing it.
   */
  HasRunningTasks: "ISSUE_HAS_RUNNING_TASKS",
  /**
   * A force delete could not stop the Issue's running Tasks, so it did not delete anything.
   * Reaching an agent mid-run goes through the orchestrator, and when that hand-off fails the
   * only safe answer is to leave the Issue alone: cascading anyway would drop the `task` rows
   * while their agent processes kept running, and nothing would be left holding a reference to
   * stop them or clean up their worktrees.
   */
  StopFailed: "ISSUE_STOP_FAILED",
  /**
   * Closing an Issue while Tasks under it are still active (spec F01 FR-9). A warning rather
   * than a wall: unlike `HasRunningTasks`, nothing is destroyed by closing, so `force` is a
   * legitimate answer — the point is that the user is told what they are leaving behind rather
   * than discovering it later on the board.
   */
  HasActiveTasks: "ISSUE_HAS_ACTIVE_TASKS",
} as const;
export type IssueErrorCode = (typeof IssueErrorCode)[keyof typeof IssueErrorCode];

export const SecretErrorCode = {
  /**
   * The Secret is still referenced by an Integration or an Agent Profile. Neither reference is a
   * database foreign key — `secret_id` is a plain column on both — so deleting the row would not
   * fail here, it would fail much later, as an authentication error at the next sync or agent
   * run. Refusing up front is what makes that impossible (spec F17 FR-6).
   */
  InUse: "SECRET_IN_USE",
} as const;
export type SecretErrorCode = (typeof SecretErrorCode)[keyof typeof SecretErrorCode];

export const AgentProfileErrorCode = {
  /**
   * The Agent Profile is still referenced by a Task, a Workflow Step, or a Session's usage
   * record. All three are real foreign keys (unlike `secret_id`, a plain column) — so a naive
   * delete would not fail here, it would fail as a raw constraint violation deep in a query that
   * has nothing to do with deleting a profile. Refusing up front, and saying what still holds
   * it, is what turns that into an ordinary product refusal instead.
   */
  InUse: "AGENT_PROFILE_IN_USE",
} as const;
export type AgentProfileErrorCode =
  (typeof AgentProfileErrorCode)[keyof typeof AgentProfileErrorCode];

export const AgentCatalogErrorCode = {
  /**
   * `(workspace_id, key)` is unique (spec F05 issue #10) — two rows with the same key would
   * make "which agent does this Profile mean" ambiguous, since `key` (not the id) is how a
   * Workspace names an agent to itself. Refused here rather than left to the database's raw
   * constraint error, which names a column, not the row the Owner was trying to add.
   */
  KeyTaken: "AGENT_CATALOG_KEY_TAKEN",
} as const;
export type AgentCatalogErrorCode =
  (typeof AgentCatalogErrorCode)[keyof typeof AgentCatalogErrorCode];
