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
} as const;
export type IntegrationErrorCode = (typeof IntegrationErrorCode)[keyof typeof IntegrationErrorCode];

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
