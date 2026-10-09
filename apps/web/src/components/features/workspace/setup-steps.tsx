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
  type WorkspaceSetupDto,
} from "@solow/contracts";
import { CircleCheck, CircleX } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
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
 * The server keeps whatever executor a new Task already gets and makes a local one only when
 * there is none — never a container on its own, because a container needs an image with Claude
 * Code inside it and SoloW ships none. So the warning for running unattended on this machine is
 * shown here, in front of the choice, and never discovered afterwards.
 */
function WhereItRuns({ setup }: { setup: WorkspaceSetupDto }) {
  const kind = setup.executorKind ?? "local";
  const permissionMode = setup.agent?.permissionMode ?? DEFAULT_HARNESS_PERMISSION_MODE;
  // Only asked when Claude would work on this machine — the one case the answer is worth saying.
  const docker = trpc.profile.executor.dockerAvailability.useQuery(undefined, {
    enabled: kind === "local",
  });

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
      <HostRunWarning executorKind="local" permissionMode={permissionMode} />
      {docker.data?.available && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Docker is installed here, so Claude could work in an isolated container instead. That
          needs a container image with Claude Code in it; once you have one,{" "}
          <Link className="underline underline-offset-2" href="/settings?section=executor-profiles">
            set it up in Settings
          </Link>
          .
        </p>
      )}
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

/** What went wrong, in words, and what to do about it (F18, edge cases). */
const PROBLEM: Record<SetupTestProblem, (harness: string, credential: string) => string> = {
  "not-connected": () => "There is nothing to test yet. Connect Claude first.",
  unreachable: () =>
    "SoloW's agent runner did not answer, so nothing was tested. Make sure SoloW is fully started, then run the test again.",
  "not-installed": (harness) =>
    harness === "Claude Code"
      ? "Claude Code isn't installed on the machine running SoloW. Install it (npm install -g @anthropic-ai/claude-code), then run the test again."
      : `${harness} isn't installed on the machine running SoloW. Install it, then run the test again.`,
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
        <div className="space-y-2" role="alert">
          <p className="flex items-start gap-2 text-sm">
            <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-state-failed" />
            {result.problem
              ? PROBLEM[result.problem](result.harness ?? "Claude Code", credential)
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
