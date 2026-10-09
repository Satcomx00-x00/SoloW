import "server-only";
import {
  type AuthMode,
  CommonErrorCode,
  type ConnectClaudeInput,
  type ConnectClaudeResultDto,
  createHarnessProfileInput,
  DEFAULT_EXECUTOR_CONFIG,
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
  setupVerifiedSchema,
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

/** The executor the setup creates when the Workspace has none, named for where it runs. */
const SETUP_EXECUTOR_NAME = "This machine";

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
 * is created only when the Workspace has none. Nothing the Owner made is renamed, rewritten or
 * removed — the only rows this ever changes are the Secret it named and the defaults it set.
 *
 * Never a container on its own initiative. The Docker executor needs an image with Claude Code
 * inside it, SoloW ships no such image, and inventing one would make a setup whose test passes on
 * the host while every Task fails in a container that has no `claude`. So a Workspace with no
 * executor gets the local one — and the screen shows the host-run warning before the Owner
 * presses Connect, never after.
 */
export async function connectClaude(
  ctx: RequestContext,
  input: ConnectClaudeInput,
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
      let executor = executors.find((row) => row.id === chosen);
      const createdExecutor = !executor;
      if (!executor) {
        executor = insertExecutorProfile(tx, ctx.workspaceId, {
          name: SETUP_EXECUTOR_NAME,
          config: DEFAULT_EXECUTOR_CONFIG,
        });
        if (!executor) return err(CommonErrorCode.ValidationFailed);
      }

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
          createdExecutor,
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
  executorKind: ExecutorKind | null;
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
  const [executor] = pick.executorProfileId
    ? await ctx.db
        .select({ kind: executorProfile.kind })
        .from(executorProfile)
        .where(
          and(
            eq(executorProfile.workspaceId, ctx.workspaceId),
            eq(executorProfile.id, pick.executorProfileId),
          ),
        )
        .limit(1)
    : [];

  return { profile: profile ?? null, executorKind: executor?.kind ?? null };
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
    ready: coreLoop && steps.every((step) => step.done),
  });
}

/** How the probe's failure reads as a setup problem — `missing` is the one renamed. */
const PROBLEM_FOR: Record<HarnessProbeFailure, SetupTestProblem> = {
  missing: "not-installed",
  credential: "credential",
  quota: "quota",
  harness: "harness",
};

type Probe = (input: {
  workspaceId: string;
  agentProfileId: string;
  turn: boolean;
}) => Promise<HarnessProbeReport>;

/**
 * The test run: one real prompt to the agent a new Task would use, through the orchestrator's
 * probe (`answerProbeTurn`), so it spends a handful of tokens and proves the binary, the
 * credential and the billing environment a run would get — not merely that a process started.
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
  const { profile } = await setupSubject(ctx);
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
    report = await probe({ workspaceId: ctx.workspaceId, agentProfileId: profile.id, turn: true });
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
