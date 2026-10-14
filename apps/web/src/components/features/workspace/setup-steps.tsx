"use client";

import {
  type AuthMode,
  CommonErrorCode,
  connectRepositoryInput,
  DEFAULT_HARNESS_PERMISSION_MODE,
  type RepositorySource,
  type SetupStepKey,
  type SetupTestProblem,
  type SetupTestResultDto,
  setupExecutorPlan,
  usableExecutorImage,
  type WorkspaceSetupDto,
} from "@solow/contracts";
import { CircleCheck, CircleX } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { HostRunWarning } from "@/components/features/host-run-warning";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * The three steps of the guided setup, one panel each (roadmap E1).
 *
 * The words are the newcomer's, not the schema's: "connect Claude", "a folder on this machine",
 * "try it". The objects underneath — the Secret, the Harness Profile, the executor — are made by
 * the server in one step and stay where Settings shows them; naming them here would hand someone
 * on their first minute four concepts they do not need yet.
 */

/**
 * The shared table (E6), with the one code this screen can say more usefully: the switch it
 * names is on this page. Everything else — a path that is not a repository, a rate limit, a
 * server fault — reads as it does everywhere, rather than as a guess about the token.
 */
const SETUP_ERRORS = {
  [CommonErrorCode.FlagDisabled]:
    "Running agents is switched off for this workspace. Turn it back on above, then try again.",
};

/**
 * Real radios inside their labels, as Appearance does it: one tab stop, arrow keys between the
 * options, and the legend announced — behaviour a set of buttons would have to re-implement.
 */
function Choice<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string; hint: string }>;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-medium text-sm">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const active = value === option.value;
          return (
            <label
              className={cn(
                "surface-edge flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2.5 transition-colors",
                "focus-within:ring-2 focus-within:ring-ring",
                active ? "border-ring bg-accent" : "hover:bg-accent/50",
              )}
              key={option.value}
            >
              <input
                checked={active}
                className="sr-only"
                name={name}
                onChange={() => onChange(option.value)}
                type="radio"
                value={option.value}
              />
              <span className="font-medium text-sm leading-tight">{option.label}</span>
              <span className="text-muted-foreground text-xs leading-snug">{option.hint}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="text-destructive text-sm" role="alert">
      {children}
    </p>
  );
}

/**
 * The two commands that build SoloW's executor image by hand — the fallback beside the setup's own
 * build, for when it cannot be asked or keeps failing in a way a terminal shows better.
 */
const BUILD_IMAGE = {
  npx: "npx @satcomx00-x00/solow executor-image",
  make: "make executor-image",
} as const;

/** How often a running build is asked about: often enough to feel live, rarely enough to be free. */
const IMAGE_BUILD_POLL_MS = 2_000;

/** "4:07" — how long the build has been running, from the orchestrator's own start time. */
function elapsedSince(startedAt: string | null, now: number): string {
  const seconds = startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Build SoloW's executor image from here (roadmap B4), so isolation by default does not stop at a
 * command a newcomer has to go and type somewhere else.
 *
 * The orchestrator runs the build and holds where it is, so this only asks: every two seconds
 * while one runs, never otherwise, and a reload mid-build picks the running one up again. When it
 * succeeds the availability check is asked again, and that is what moves the setup's plan to the
 * container — this component never decides where Claude works.
 *
 * Announced once per state, not per line: the live region says "building", "built" or the failure,
 * while the elapsed time and Docker's newest line sit beside it unannounced, since a screen reader
 * reading out a build log every two seconds helps nobody.
 */
function BuildExecutorImage({ rebuild = false }: { rebuild?: boolean }) {
  const utils = trpc.useUtils();
  const status = trpc.profile.executor.imageBuild.useQuery(undefined, {
    refetchInterval: (query) =>
      query.state.data?.state === "building" ? IMAGE_BUILD_POLL_MS : false,
  });
  const build = trpc.profile.executor.buildImage.useMutation({
    onSuccess: (next) => {
      if (next) utils.profile.executor.imageBuild.setData(undefined, next);
    },
  });
  const current = status.data ?? null;
  const building = current?.state === "building";
  // A success is this screen's to report only if it watched the build run. One the orchestrator
  // remembers from earlier says nothing about now — the image may have been removed since, and
  // claiming it built would take away the button that builds it again.
  const [watched, setWatched] = useState(false);
  if (building && !watched) setWatched(true);
  const builtAt = current?.state === "succeeded" && watched ? current.finishedAt : null;

  useEffect(() => {
    if (builtAt) void utils.profile.executor.dockerAvailability.invalidate();
  }, [builtAt, utils]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!building) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [building]);

  const failed = current?.state === "failed" ? current : null;
  // The mutation answered, but with nothing: the orchestrator could not be asked to start.
  const unanswered = build.isSuccess && build.data === null;

  return (
    <div className="space-y-2">
      <p aria-live="polite" className="text-sm" role="status">
        {building
          ? "Building the image on this machine. It takes a few minutes."
          : builtAt
            ? "The image is built."
            : ""}
      </p>
      {building && (
        <p className="flex min-w-0 items-baseline gap-2 text-muted-foreground text-xs">
          <span className="shrink-0 tabular-nums">{elapsedSince(current.startedAt, now)}</span>
          <span className="truncate font-mono">{current.output.at(-1) ?? "Starting…"}</span>
        </p>
      )}
      {failed && (
        <div className="space-y-2">
          <ErrorLine>{failed.reason ?? "The image didn't build."}</ErrorLine>
          {failed.output.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                What Docker printed
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono leading-relaxed">
                {failed.output.join("\n")}
              </pre>
            </details>
          )}
        </div>
      )}
      {(unanswered || build.error) && (
        <ErrorLine>
          SoloW's agent runner did not answer, so nothing was built. Make sure SoloW is fully
          started, then try again.
        </ErrorLine>
      )}
      {!builtAt && (
        <Button
          loading={building || build.isPending}
          onClick={() => build.mutate()}
          size="sm"
          type="button"
          variant={failed ? "outline" : "default"}
        >
          {building
            ? "Building…"
            : failed
              ? "Try again"
              : rebuild
                ? "Rebuild the image"
                : "Build the isolated environment"}
        </Button>
      )}
      {!building && !builtAt && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Or in a terminal on this machine: <code className="font-mono">{BUILD_IMAGE.npx}</code> (or{" "}
          <code className="font-mono">{BUILD_IMAGE.make}</code> in a SoloW checkout).
        </p>
      )}
    </div>
  );
}

const BILLING_OPTIONS = [
  {
    value: "subscription",
    label: "Claude subscription",
    hint: "Pro or Max. Work runs on the plan you already pay for.",
  },
  {
    value: "api_key",
    label: "Anthropic API key",
    hint: "Pay as you go, billed to your Anthropic Console account.",
  },
] as const satisfies ReadonlyArray<{ value: AuthMode; label: string; hint: string }>;

/**
 * Where Claude will work, said before the Owner presses Connect.
 *
 * The same rule the server applies (`setupExecutorPlan`): the isolated container when Docker is
 * here and already has the image with Claude Code in it, otherwise whatever a new Task already
 * gets, and this machine when there is nothing. So the warning for running unattended on this
 * machine is shown here, in front of the choice, and never discovered afterwards — and when the
 * only thing missing for isolation is the image, this says how to build it.
 */
function WhereItRuns({ setup }: { setup: WorkspaceSetupDto }) {
  const permissionMode = setup.agent?.permissionMode ?? DEFAULT_HARNESS_PERMISSION_MODE;
  // Only asked when the answer could change where Claude works: no executor yet, or one this
  // machine runs.
  const docker = trpc.profile.executor.dockerAvailability.useQuery(undefined, {
    enabled: setup.executorKind === null || setup.executorKind === "local",
  });
  const plan = setupExecutorPlan({
    current: setup.executorKind
      ? { kind: setup.executorKind, replaceable: setup.executorReplaceable }
      : null,
    isolatedImage: usableExecutorImage(docker.data),
  });
  const kind = plan.action === "create" ? plan.kind : (setup.executorKind ?? "local");

  if (plan.action === "create" && plan.kind === "docker") {
    return (
      <p className="text-muted-foreground text-sm">
        Claude will work in an isolated container on this machine, from the{" "}
        <code className="font-mono">{plan.image}</code> image. It works on its own copy of the
        repository and cannot see the rest of your files.
        {/* The setup's own local fallback moves only when Connect is pressed again. */}
        {setup.executorKind !== null && " Connect again to move Claude there."}
      </p>
    );
  }
  if (kind === "docker") {
    return (
      <p className="text-muted-foreground text-sm">
        Claude will work in the isolated container this workspace already uses.
      </p>
    );
  }
  if (kind !== "local") {
    return (
      <p className="text-muted-foreground text-sm">
        Claude will work where this workspace already runs its tasks.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">Claude will work on this machine.</p>
      <HostRunWarning
        executorKind="local"
        permissionMode={permissionMode}
        title="It works with your access, without asking first"
      >
        Claude can read, change and send anything your account can, and it does not stop to check
        before it acts. An issue or a web page written to mislead it could steer it, so point it
        only at repositories and issues you trust.
      </HostRunWarning>
      {docker.data?.available &&
        // The setup would move Claude into the container by itself, once the image exists.
        (setup.executorKind === null || setup.executorReplaceable ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs leading-relaxed">
              Docker is installed here, so Claude can work in an isolated container instead. Its
              image is built once, on this machine, and takes a few minutes
              {setup.executorKind === null ? "" : "; then connect again to move Claude into it"}.
            </p>
            <BuildExecutorImage />
          </div>
        ) : (
          <p className="text-muted-foreground text-xs leading-relaxed">
            Docker is installed here, so Claude could work in an isolated container instead.{" "}
            <Link
              className="underline underline-offset-2"
              href="/settings?section=executor-profiles"
            >
              Set one up in Settings
            </Link>
            {usableExecutorImage(docker.data)
              ? `, with the ${docker.data.executorImage.name} image.`
              : "."}
          </p>
        ))}
    </div>
  );
}

/** Step 1: the one thing the setup cannot work out for itself. */
export function ConnectClaudeStep({
  setup,
  onConnected,
}: {
  setup: WorkspaceSetupDto;
  onConnected: () => void;
}) {
  const utils = trpc.useUtils();
  const [billing, setBilling] = useState<AuthMode>(setup.agent?.billing ?? "subscription");
  const [credential, setCredential] = useState("");
  const connect = trpc.setup.connectClaude.useMutation({
    onSuccess: () => {
      // The value leaves the page as soon as it is stored: nothing reads it back, ever.
      setCredential("");
      void utils.workspace.setup.invalidate();
      onConnected();
    },
  });
  const connected = setup.steps.find((s) => s.key === "claude");
  const isToken = billing === "subscription";

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (credential.trim()) connect.mutate({ billing, credential });
      }}
    >
      {connected?.done && (
        <p className="text-muted-foreground text-sm">
          Connected: {connected.detail}. To replace the {isToken ? "token" : "key"} or switch how
          you pay, fill this in again.
        </p>
      )}

      <Choice
        legend="How do you pay for Claude?"
        name="setup-billing"
        onChange={setBilling}
        options={BILLING_OPTIONS}
        value={billing}
      />

      <div className="grid gap-2">
        <Label htmlFor="setup-credential">{isToken ? "Subscription token" : "API key"}</Label>
        <Input
          autoComplete="off"
          id="setup-credential"
          onChange={(event) => setCredential(event.target.value)}
          placeholder={isToken ? "sk-ant-oat01-…" : "sk-ant-api03-…"}
          spellCheck={false}
          type="password"
          value={credential}
        />
        <p className="text-muted-foreground text-xs leading-relaxed">
          {isToken ? (
            <>
              In a terminal, run <code className="font-mono">claude setup-token</code>, sign in, and
              paste the token it prints.
            </>
          ) : (
            <>Create one in the Anthropic Console (console.anthropic.com), under API keys.</>
          )}{" "}
          It is stored encrypted and never shown again.
        </p>
      </div>

      <WhereItRuns setup={setup} />

      {connect.error && <ErrorLine>{describeError(connect.error, SETUP_ERRORS)}</ErrorLine>}

      <Button disabled={!credential.trim()} loading={connect.isPending} type="submit">
        Connect Claude
      </Button>
    </form>
  );
}

const SOURCE_OPTIONS = [
  {
    value: "local_path",
    label: "A folder on this machine",
    hint: "A Git checkout SoloW can reach, by its full path.",
  },
  {
    value: "remote_url",
    label: "A Git URL",
    hint: "SoloW clones it. A private one needs your GitHub or GitLab account connected.",
  },
] as const satisfies ReadonlyArray<{ value: RepositorySource; label: string; hint: string }>;

/** "/home/me/code/app/" → "app", "git@github.com:me/app.git" → "app". The name is inferred, not asked. */
export function repositoryNameFrom(location: string): string {
  const last =
    location
      .trim()
      .replace(/[/\\]+$/, "")
      .split(/[/:\\]/)
      .pop() ?? "";
  return last.replace(/\.git$/, "");
}

/** Step 2: somewhere for Claude to work. Reuses `repository.connect` — nothing new underneath. */
export function RepositoryStep({
  setup,
  onConnected,
}: {
  setup: WorkspaceSetupDto;
  onConnected: () => void;
}) {
  const utils = trpc.useUtils();
  const [source, setSource] = useState<RepositorySource>("local_path");
  const [location, setLocation] = useState("");
  const [invalid, setInvalid] = useState(false);
  const connect = trpc.repository.connect.useMutation({
    onSuccess: () => {
      setLocation("");
      void utils.workspace.setup.invalidate();
      void utils.repository.list.invalidate();
      onConnected();
    },
  });
  const done = setup.steps.find((s) => s.key === "repository");
  const name = repositoryNameFrom(location);
  const isPath = source === "local_path";

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const input = { name: name || location.trim(), source, location: location.trim() };
        // Checked here with the contract's own rule, so a mistake is answered in words on the
        // field rather than as the validation error the server would send back.
        const valid = connectRepositoryInput.safeParse(input).success;
        setInvalid(!valid);
        if (valid) connect.mutate(input);
      }}
    >
      {done?.done && (
        <p className="text-muted-foreground text-sm">
          Ready: {done.detail}. You can add another, or move on.
        </p>
      )}

      <Choice
        legend="Where is the code?"
        name="setup-repository-source"
        onChange={(next) => {
          setSource(next);
          setInvalid(false);
        }}
        options={SOURCE_OPTIONS}
        value={source}
      />

      <div className="grid gap-2">
        <Label htmlFor="setup-repository-location">{isPath ? "Full path" : "Git URL"}</Label>
        <Input
          aria-invalid={invalid || undefined}
          id="setup-repository-location"
          onChange={(event) => {
            setLocation(event.target.value);
            setInvalid(false);
          }}
          placeholder={isPath ? "/home/you/code/my-app" : "https://github.com/you/my-app.git"}
          spellCheck={false}
          value={location}
        />
        {invalid ? (
          <ErrorLine>
            {isPath
              ? "Use the full path, starting with /."
              : "That doesn't look like a Git URL. It should start with https://, ssh:// or git@."}
          </ErrorLine>
        ) : (
          name && <p className="text-muted-foreground text-xs">It will be called “{name}”.</p>
        )}
      </div>

      {connect.error && <ErrorLine>{describeError(connect.error, SETUP_ERRORS)}</ErrorLine>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button disabled={!location.trim()} loading={connect.isPending} type="submit">
          Use this repository
        </Button>
        <Link
          className="text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
          href="/settings?section=integrations"
        >
          On GitHub or GitLab? Connect your account to import repositories with their issues.
        </Link>
      </div>
    </form>
  );
}

/**
 * What went wrong, in words, and what to do about it (F18, edge cases). `inContainer` because the
 * test runs where the setup's Tasks run: a harness missing from the image is fixed by rebuilding
 * the image, and telling someone to install it on their machine would send them the wrong way.
 */
const PROBLEM: Record<
  SetupTestProblem,
  (harness: string, credential: string, inContainer: boolean) => string
> = {
  "not-connected": () => "There is nothing to test yet. Connect Claude first.",
  unreachable: () =>
    "SoloW's agent runner did not answer, so nothing was tested. Make sure SoloW is fully started, then run the test again.",
  "not-installed": (harness, _credential, inContainer) =>
    inContainer
      ? `${harness} isn't in the container image Claude runs in. If it is SoloW's image, rebuild it below, then run the test again.`
      : harness === "Claude Code"
        ? "Claude Code isn't installed on the machine running SoloW. Install it (npm install -g @anthropic-ai/claude-code), then run the test again."
        : `${harness} isn't installed on the machine running SoloW. Install it, then run the test again.`,
  executor: () =>
    "SoloW couldn't start the isolated container Claude runs in. Check that Docker is running and that its image is built (below), then run the test again.",
  credential: (_harness, credential) =>
    `Claude didn't accept your ${credential}. Go back to Connect Claude and paste a fresh one.`,
  quota: () =>
    "Your Claude plan has reached its usage limit for now. Your setup is fine; run the test again once the limit resets.",
  harness: (harness) =>
    `${harness} started but didn't finish its reply. Run the test again; if it keeps failing, check that ${harness} works in a terminal on this machine.`,
};

/** Step 3: prove it before leaving the flow. */
export function TestStep({
  setup,
  onGoTo,
  onPassed,
}: {
  setup: WorkspaceSetupDto;
  onGoTo: (step: SetupStepKey) => void;
  onPassed: () => void;
}) {
  const utils = trpc.useUtils();
  const [result, setResult] = useState<SetupTestResultDto | null>(null);
  const test = trpc.setup.test.useMutation({
    onSuccess: (report) => {
      setResult(report);
      void utils.workspace.setup.invalidate();
      if (report.ok) onPassed();
    },
  });
  const step = setup.steps.find((s) => s.key === "test");
  const credential = setup.agent?.billing === "api_key" ? "API key" : "token";

  if (step?.blockedBy === "claude") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted-foreground text-sm">
          Connect Claude first — there is nothing to test yet.
        </p>
        <Button onClick={() => onGoTo("claude")} size="sm" type="button" variant="outline">
          Connect Claude
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm leading-relaxed">
        SoloW asks Claude for a one-word reply, the same way it starts real work. It uses a few
        tokens and can take up to a minute.
      </p>

      {result?.ok ? (
        <p className="flex items-start gap-2 text-sm" role="status">
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-state-done" />
          {result.answered
            ? "Claude answered. Everything is working."
            : `${result.harness ?? "The agent"} started and answered. It can't be sent a test prompt outside a task, so its first task is the full test.`}
        </p>
      ) : result ? (
        <div className="space-y-2">
          <div className="space-y-2" role="alert">
            <p className="flex items-start gap-2 text-sm">
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-state-failed" />
              {result.problem
                ? PROBLEM[result.problem](
                    result.harness ?? "Claude Code",
                    credential,
                    setup.executorKind === "docker",
                  )
                : "The test did not pass. Run it again."}
            </p>
            {result.fixStep && (
              <Button
                onClick={() => onGoTo(result.fixStep ?? "claude")}
                size="sm"
                type="button"
                variant="outline"
              >
                Go to Connect Claude
              </Button>
            )}
          </div>
          {/* Both are about the image the container runs, which can be rebuilt from here — outside
              the alert, whose every change would otherwise be read out again as the build runs. */}
          {setup.executorKind === "docker" &&
            (result.problem === "executor" || result.problem === "not-installed") && (
              <BuildExecutorImage rebuild />
            )}
        </div>
      ) : (
        step?.done && (
          <p className="flex items-start gap-2 text-sm">
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-state-done" />
            Passed for the current {credential}.
          </p>
        )
      )}

      {test.error && <ErrorLine>{describeError(test.error, SETUP_ERRORS)}</ErrorLine>}

      <Button
        loading={test.isPending}
        onClick={() => test.mutate()}
        type="button"
        variant={step?.done || result ? "outline" : "default"}
      >
        {test.isPending ? "Testing…" : step?.done || result ? "Run the test again" : "Run the test"}
      </Button>
    </div>
  );
}
