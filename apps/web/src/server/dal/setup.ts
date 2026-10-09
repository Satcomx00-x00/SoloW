import "server-only";
import {
  type AuthMode,
  CommonErrorCode,
  type ConnectClaudeInput,
  type ConnectClaudeResultDto,
  createHarnessProfileInput,
  DEFAULT_EXECUTOR_CONFIG,
  type DockerAvailabilityReport,
  type ExecutorKind,
  err,
  type HarnessConfigErrorCode,
  type HarnessPermissionMode,
  type HarnessProbeFailure,
  type HarnessProbeReport,
  ok,
  quickTaskProfiles,
  type Result,
  SETUP_VERIFIED_PREFERENCE_KEY,
  type SecretKind,
  type SetupStepDto,
  type SetupTestProblem,
  type SetupTestResultDto,
  type SetupVerified,
  setupExecutorPlan,
  setupVerifiedSchema,
  usableExecutorImage,
  type WorkspaceSetupDto,
} from "@solow/contracts";
import {
  ensureDefaultHarnessCatalog,
  ensureDefaultWorkflows,
  executorProfile,
  FLAGS,
  harnessCatalog,
  harnessProfile,
  repository,
  secret,
  sessionUsage,
  uiPreference,
} from "@solow/db";
import { and, asc, eq, gte } from "drizzle-orm";
import { orchestrator } from "../orchestrator-client.js";
import type { RequestContext } from "./context.js";
import { getTaskDefaults, readTaskDefaults, writeTaskDefaults } from "./preference.js";
import { insertExecutorProfile, insertHarnessProfile, listProfileChoices } from "./profile.js";
import { writeSecret } from "./secret.js";
import { getWorkspace, getWorkspaceFlags } from "./workspace.js";

/**
 * The guided setup (roadmap E1, spec F18): connect Claude, choose a repository, try it.
 *
 * Everything it makes is an ordinary row — a Secret, a Harness Profile, an Executor Profile and
 * the new-Task defaults — written through the same functions Settings uses, so there is no second
 * idea of what a Profile is. What it adds is the order, the plain words, and a test run that
 * proves the result before anyone leaves the flow.
 */

/**
 * What the setup names what it makes, one pair per billing mode.
 *
 * Plain names, because Settings is where the Owner meets them later. Per mode rather than one
 * pair, because a Profile's billing mode is fixed for life (`updateHarnessProfileInput` refuses
 * to change it — finished runs were billed under it), so switching from a subscription to an API
 * key has to make the other pair rather than rewrite this one. Re-running with the same mode
 * finds the same pair by name and replaces the credential in place.
 */
const MADE_BY_SETUP: Record<
  AuthMode,
  { secret: string; secretKind: SecretKind; profile: string; billing: string }
> = {
  subscription: {
    secret: "Claude subscription token",
    secretKind: "subscription_token",
    profile: "Claude (subscription)",
    billing: "subscription",
  },
  api_key: {
    secret: "Claude API key",
    secretKind: "api_key",
    profile: "Claude (API key)",
    billing: "API key",
  },
};

/**
 * The executors the setup creates, named for where they run. The local name is also how the setup
 * recognises its own fallback later (`isSetupFallback`): an executor by that name, of that kind,
 * is one nobody chose.
 */
const SETUP_EXECUTOR_NAME = { local: "This machine", docker: "Isolated container" } as const;

/**
 * Whether the executor a new Task gets is the local one the setup made for want of anything
 * better — the only one connecting again may succeed (`setupExecutorPlan`). Not when the Workspace
 * has a container executor: keeping the local one as the default beside it is a choice.
 */
function isSetupFallback(
  current: { kind: ExecutorKind; name: string },
  executors: ReadonlyArray<{ kind: ExecutorKind }>,
): boolean {
  return (
    current.kind === "local" &&
    current.name === SETUP_EXECUTOR_NAME.local &&
    !executors.some((row) => row.kind === "docker")
  );
}

type ConnectError =
  | typeof CommonErrorCode.ValidationFailed
  | typeof CommonErrorCode.NotFound
  | typeof HarnessConfigErrorCode.HarnessMismatch;

/**
 * "Connect Claude", in one transaction: store the credential, bind Claude Code to it, make sure
 * there is somewhere for it to run, and make that pair what a new Task starts with.
 *
 * Idempotent by construction. The credential is stored by name, so a second run replaces its
 * value rather than adding another Secret; the Profile is the one already bound to that Secret,
 * or made once; the executor is whatever a new Task already gets (`quickTaskProfiles`), and one
 * is created only by `setupExecutorPlan`'s rule — when the Workspace has none, or when the one it
 * has is the setup's own local fallback and the isolated image has since been built. Nothing the
 * Owner made is renamed, rewritten or removed — the only rows this ever changes are the Secret it
 * named and the defaults it set.
 *
 * Isolated when it can be (roadmap B4): a container on this machine, from the image
 * `make executor-image` builds, once the orchestrator says Docker answers and already has that
 * image. Not before: a container from an image without `claude` in it — or one that cannot be
 * pulled, which a local tag cannot — is a Task that never starts. Otherwise the local executor,
 * and the screen shows the host-run warning before the Owner presses Connect, never after.
 *
 * `availability` is a parameter so the choice can be tested without an orchestrator. Asked before
 * the transaction, because it is a network round trip and a write lock must not wait on one.
 */
export async function connectClaude(
  ctx: RequestContext,
  input: ConnectClaudeInput,
  availability: (input: { workspaceId: string }) => Promise<DockerAvailabilityReport | null> = (
    query,
  ) => orchestrator.dockerAvailability(query),
): Promise<
  Result<
    { result: Omit<ConnectClaudeResultDto, "resumedTaskCount">; secretId: string },
    ConnectError
  >
> {
  // Outside the transaction: it is async, idempotent, and a seed every Workspace is meant to
  // have anyway — a rollback below has no reason to take it back.
  const catalogId = await ensureDefaultHarnessCatalog(ctx.db, ctx.workspaceId);
  const made = MADE_BY_SETUP[input.billing];
  const isolatedImage = usableExecutorImage(
    await availability({ workspaceId: ctx.workspaceId }).catch(() => null),
  );

  const written = ctx.db.transaction(
    (
      tx,
    ): Result<
      { result: Omit<ConnectClaudeResultDto, "resumedTaskCount">; secretId: string },
      ConnectError
    > => {
      const stored = writeSecret(tx, ctx.workspaceId, {
        name: made.secret,
        kind: made.secretKind,
        value: input.credential,
      });
      if (!stored) return err(CommonErrorCode.ValidationFailed);

      const [kept] = tx
        .select({ id: harnessProfile.id })
        .from(harnessProfile)
        .where(
          and(
            eq(harnessProfile.workspaceId, ctx.workspaceId),
            eq(harnessProfile.agentCatalogId, catalogId),
            eq(harnessProfile.authMode, input.billing),
            eq(harnessProfile.secretId, stored.id),
          ),
        )
        .orderBy(asc(harnessProfile.createdAt), asc(harnessProfile.id))
        .limit(1)
        .all();
      let harnessProfileId = kept?.id;
      if (!harnessProfileId) {
        const created = insertHarnessProfile(
          tx,
          ctx.workspaceId,
          // Parsed, so the Profile gets exactly the defaults Settings would give it.
          createHarnessProfileInput.parse({
            name: made.profile,
            agentCatalogId: catalogId,
            authMode: input.billing,
            secretId: stored.id,
          }),
        );
        if (!created.ok) return created;
        harnessProfileId = created.data.id;
      }

      const executors = tx
        .select({
          id: executorProfile.id,
          name: executorProfile.name,
          kind: executorProfile.kind,
          createdAt: executorProfile.createdAt,
        })
        .from(executorProfile)
        .where(eq(executorProfile.workspaceId, ctx.workspaceId))
        .all();
      const chosen = quickTaskProfiles({
        stored: readTaskDefaults(tx, ctx),
        harnesses: [],
        executors,
      }).executorProfileId;
      const current = executors.find((row) => row.id === chosen);
      const plan = setupExecutorPlan({
        current: current
          ? { kind: current.kind, replaceable: isSetupFallback(current, executors) }
          : null,
        isolatedImage,
      });
      let executor: { id: string; kind: ExecutorKind } | undefined = current;
      if (plan.action === "create") {
        executor = insertExecutorProfile(tx, ctx.workspaceId, {
          name: SETUP_EXECUTOR_NAME[plan.kind],
          config:
            plan.kind === "docker"
              ? { kind: "docker", image: plan.image, mounts: [], env: {} }
              : DEFAULT_EXECUTOR_CONFIG,
        });
      }
      if (!executor) return err(CommonErrorCode.ValidationFailed);

      const defaults = writeTaskDefaults(tx, ctx, {
        harnessProfileId,
        executorProfileId: executor.id,
      });
      if (!defaults.ok) return defaults;

      return ok({
        result: {
          harnessProfileId,
          executorProfileId: executor.id,
          executorKind: executor.kind,
          createdExecutor: plan.action === "create",
        },
        secretId: stored.id,
      });
    },
    { behavior: "immediate" },
  );
  if (!written.ok) return written;

  // After the commit, as `createHarnessProfile` does it: the default Workflows were waiting for a
  // first Profile to name in their Steps.
  await ensureDefaultWorkflows(ctx.db, ctx.workspaceId);
  return written;
}

/** The agent a new Task would start with, and what the setup needs to know about it. */
interface SetupSubject {
  profile: {
    id: string;
    harness: string;
    billing: AuthMode;
    permissionMode: HarnessPermissionMode;
    /** When its credential was last written — null when the Secret it names is gone. */
    secretUpdatedAt: string | null;
  } | null;
  /** The executor a new Task would get — where the test runs (`runSetupTest`). */
  executorProfileId: string | null;
  executorKind: ExecutorKind | null;
  /** See `isSetupFallback`. */
  executorReplaceable: boolean;
}

/**
 * Read through `quickTaskProfiles`, the rule a Quick task applies: the setup describes, and
 * tests, the Profile a Task would actually get — not whichever one it happened to create.
 */
async function setupSubject(ctx: RequestContext): Promise<SetupSubject> {
  const defaults = await getTaskDefaults(ctx);
  const pick = quickTaskProfiles({
    stored: defaults.ok ? defaults.data.defaults : null,
    ...(await listProfileChoices(ctx)),
  });

  const [profile] = pick.agentProfileId
    ? await ctx.db
        .select({
          id: harnessProfile.id,
          harness: harnessCatalog.displayName,
          billing: harnessProfile.authMode,
          permissionMode: harnessProfile.permissionMode,
          secretUpdatedAt: secret.updatedAt,
        })
        .from(harnessProfile)
        .innerJoin(harnessCatalog, eq(harnessCatalog.id, harnessProfile.agentCatalogId))
        // `secret_id` is a plain column, not a foreign key: the Secret can be missing.
        .leftJoin(
          secret,
          and(eq(secret.id, harnessProfile.secretId), eq(secret.workspaceId, ctx.workspaceId)),
        )
        .where(
          and(
            eq(harnessProfile.workspaceId, ctx.workspaceId),
            eq(harnessProfile.id, pick.agentProfileId),
          ),
        )
        .limit(1)
    : [];
  const executors = await ctx.db
    .select({ id: executorProfile.id, name: executorProfile.name, kind: executorProfile.kind })
    .from(executorProfile)
    .where(eq(executorProfile.workspaceId, ctx.workspaceId));
  const executor = executors.find((row) => row.id === pick.executorProfileId);

  return {
    profile: profile ?? null,
    executorProfileId: executor?.id ?? null,
    executorKind: executor?.kind ?? null,
    executorReplaceable: executor ? isSetupFallback(executor, executors) : false,
  };
}

/**
 * Whether this Profile, with its current credential, has been shown to work.
 *
 * Two kinds of evidence, both tied to the credential as it is now: a passed test run that named
 * this Profile and this version of its Secret, or a real turn recorded against the Profile since
 * that Secret was last written. The second is why a Workspace that has been running Tasks for
 * weeks is not sent back through the setup to prove what its history already proves.
 */
async function isVerified(
  ctx: RequestContext,
  profile: NonNullable<SetupSubject["profile"]>,
): Promise<boolean> {
  if (!profile.secretUpdatedAt) return false;
  const [row] = await ctx.db
    .select({ value: uiPreference.value })
    .from(uiPreference)
    .where(
      and(
        eq(uiPreference.workspaceId, ctx.workspaceId),
        eq(uiPreference.userId, ctx.userId),
        eq(uiPreference.key, SETUP_VERIFIED_PREFERENCE_KEY),
      ),
    )
    .limit(1);
  const remembered = setupVerifiedSchema.safeParse(row?.value);
  if (
    remembered.success &&
    remembered.data.harnessProfileId === profile.id &&
    remembered.data.secretUpdatedAt === profile.secretUpdatedAt
  ) {
    return true;
  }

  const [used] = await ctx.db
    .select({ id: sessionUsage.id })
    .from(sessionUsage)
    .where(
      and(
        eq(sessionUsage.workspaceId, ctx.workspaceId),
        eq(sessionUsage.agentProfileId, profile.id),
        gte(sessionUsage.at, profile.secretUpdatedAt),
      ),
    )
    .limit(1);
  return Boolean(used);
}

/** "solow", "solow and crawler", "solow, crawler and 3 more" — names, not a count. */
function namesOf(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  const shown = names.slice(0, 2).join(", ");
  return names.length === 3 ? `${shown} and ${names[2]}` : `${shown} and ${names.length - 2} more`;
}

/**
 * Where the setup stands, read from what the Workspace has on every call.
 *
 * Derived rather than stored, for the reason the checklist before it gave: a remembered
 * "completed" would go on saying so after the credential it counted was deleted, which is
 * precisely when it should say otherwise. So it is resumable for free — leave halfway, come back,
 * and it is where the rows say it is — and it comes back by itself when something it counted goes.
 */
export async function getWorkspaceSetup(ctx: RequestContext): Promise<Result<WorkspaceSetupDto>> {
  const found = await getWorkspace(ctx);
  if (!found.ok) return found;

  const flags = await getWorkspaceFlags(ctx.db, ctx.workspaceId);
  const coreLoop = flags["ff-core-program"] ?? FLAGS["ff-core-program"].default;
  const subject = await setupSubject(ctx);
  const repositories = await ctx.db
    .select({ name: repository.name })
    .from(repository)
    .where(eq(repository.workspaceId, ctx.workspaceId))
    .orderBy(asc(repository.createdAt), asc(repository.id));

  const { profile } = subject;
  const connected =
    profile !== null && profile.secretUpdatedAt !== null && subject.executorKind !== null;
  const tested = connected && (await isVerified(ctx, profile));

  const steps: SetupStepDto[] = [
    {
      key: "claude",
      done: connected,
      detail: profile ? `${profile.harness} · ${MADE_BY_SETUP[profile.billing].billing}` : "",
      blockedBy: null,
    },
    {
      key: "repository",
      done: repositories.length > 0,
      detail: namesOf(repositories.map((row) => row.name)),
      blockedBy: null,
    },
    {
      key: "test",
      done: tested,
      detail: tested ? "Passed" : "",
      // A test needs something to test; offering it first would only ever fail.
      blockedBy: connected ? null : "claude",
    },
  ];

  return ok({
    workspace: found.data,
    coreLoop,
    steps,
    agent: profile
      ? {
          harness: profile.harness,
          billing: profile.billing,
          permissionMode: profile.permissionMode,
        }
      : null,
    executorKind: subject.executorKind,
    executorReplaceable: subject.executorReplaceable,
    ready: coreLoop && steps.every((step) => step.done),
  });
}

/** How the probe's failure reads as a setup problem — `missing` is the one renamed. */
const PROBLEM_FOR: Record<HarnessProbeFailure, SetupTestProblem> = {
  missing: "not-installed",
  credential: "credential",
  quota: "quota",
  executor: "executor",
  harness: "harness",
};

type Probe = (input: {
  workspaceId: string;
  agentProfileId: string;
  turn: boolean;
  executorProfileId?: string;
}) => Promise<HarnessProbeReport>;

/**
 * The test run: one real prompt to the agent a new Task would use, through the orchestrator's
 * probe (`answerProbeTurn`), so it spends a handful of tokens and proves the binary, the
 * credential and the billing environment a run would get — not merely that a process started.
 *
 * And *where* a run would get them: the probe is told the executor a new Task would get, so a
 * setup that put Claude in a container is tested in one, against the image, and not by whatever
 * happens to be installed on the orchestrator's host (roadmap B4).
 *
 * A pass is remembered against the Profile and the version of its credential it tested (see
 * `isVerified`). A failure is answered as a cause and the step that fixes it, never as the
 * harness's own words: the screen turns those into a sentence (F18, edge cases).
 *
 * `probe` is a parameter so the mapping can be tested without an orchestrator.
 */
export async function runSetupTest(
  ctx: RequestContext,
  probe: Probe = (input) => orchestrator.probeHarnessProfile(input),
): Promise<SetupTestResultDto> {
  const { profile, executorProfileId } = await setupSubject(ctx);
  if (!profile?.secretUpdatedAt) {
    return {
      ok: false,
      problem: "not-connected",
      fixStep: "claude",
      harness: null,
      answered: false,
    };
  }

  let report: HarnessProbeReport;
  try {
    report = await probe({
      workspaceId: ctx.workspaceId,
      agentProfileId: profile.id,
      turn: true,
      ...(executorProfileId ? { executorProfileId } : {}),
    });
  } catch {
    return {
      ok: false,
      problem: "unreachable",
      fixStep: null,
      harness: profile.harness,
      answered: false,
    };
  }

  if (!report.ok) {
    const problem = PROBLEM_FOR[report.failure ?? "harness"];
    return {
      ok: false,
      problem,
      // Only a refused credential is fixed by a step in this flow; the rest are fixed on the host
      // or by waiting, and pointing at a step that cannot help would send someone in a circle.
      fixStep: problem === "credential" ? "claude" : null,
      harness: profile.harness,
      answered: false,
    };
  }

  const verified: SetupVerified = {
    harnessProfileId: profile.id,
    secretUpdatedAt: profile.secretUpdatedAt,
  };
  await ctx.db
    .insert(uiPreference)
    .values({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      key: SETUP_VERIFIED_PREFERENCE_KEY,
      value: verified,
    })
    .onConflictDoUpdate({
      target: [uiPreference.workspaceId, uiPreference.userId, uiPreference.key],
      set: { value: verified, updatedAt: new Date().toISOString() },
    });

  return {
    ok: true,
    problem: null,
    fixStep: null,
    harness: profile.harness,
    answered: report.answered ?? false,
  };
}
