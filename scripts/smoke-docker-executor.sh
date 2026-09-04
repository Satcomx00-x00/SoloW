#!/usr/bin/env sh
# Drive the real Docker executor against the real daemon, and check what it actually did.
#
# `docker.test.ts` proves the driver composes the argv it means to, against a fake host executor
# that records strings. That is worth having and it cannot fail the way this feature fails: every
# claim the driver rests on is a claim about how the daemon, the kernel and a busybox shell
# behave, and a fake agrees with whatever the driver says. Three of them were wrong in review and
# only a live run said so — `-v` silently creating an empty root-owned worktree, `docker exec`
# without `-i` writing a zero-byte file and exiting 0, and a `kill` aimed at the client leaving
# the agent running inside the container.
#
# So this asks the six acceptance criteria as questions about the world rather than about the
# code, and each one is shaped so that the wrong answer is a failure and not a quieter pass:
#
#   AC-1  an agent runs *inside* a container       — the daemon lists it, and its UTS hostname is
#                                                    that container's id
#   AC-2  one executor cannot see another's work   — two Tasks on one Repository, driven with
#                                                    the mount set production builds for them
#   AC-3  a credential reaches the process only    — the agent prints it; `docker inspect` and the
#                                                    host's `ps` must not
#   AC-4  `dispose()` removes the container        — asked of the daemon, after the fact
#   AC-5  the resource ceilings are enforced       — both cgroup files, *and* the kernel acting
#                                                    on each: an OOM kill and a throttle count
#   AC-6  an unpullable image fails legibly        — with a reason, and with nothing created
#
# Those six all end while the run is still up, which left the other half of three of them
# unasked — what happens *after* something ends. Three further blocks at the bottom close that,
# and each one is a differential: two situations the code has to tell apart, run side by side,
# rather than one situation asserted to go the way the code already says it goes.
#
#   AC-6  the preflight ladder's own rungs         — a dead socket, an absent binary, an
#                                                    unpullable image and a broken one, which
#                                                    must give four *different* reasons
#   AC-3  the credential does not outlive the run  — neither bind-mounted root nor the host's
#                                                    copy of the container's `$HOME` holds it
#   AC-4  the reaper, against a simulated crash    — two containers alike but for the epoch in
#                                                    `/run/solow/owner`: the crashed one goes,
#                                                    the live one stays
#
# The driver itself is exercised through `createDockerExecutor` composed over a real
# `createLocalExecutor`, which is exactly what production builds — a stand-in host executor here
# would put a fake back underneath the only test that exists to remove it. That part is a Bun
# program, because the driver is one; this script owns the daemon, the cleanup and the host-side
# half of AC-1 and AC-3, which have to be asked by an ordinary process on the host to mean
# anything.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

# Small, has the userland the shims need, and the same default `docker.live.test.ts` uses.
# Overridable for a machine that can only reach a private registry.
IMAGE="${SMOKE_DOCKER_IMAGE:-alpine:3}"
PROBE_TIMEOUT="${SMOKE_DOCKER_TIMEOUT:-180}"

# Whether "no daemon here" is a skip or a failure. Unset by default, so a developer running this
# by hand on a laptop with Docker Desktop shut down gets the friendly skip below; set to `1` by
# `.github/workflows/verify.yml`, because in a gate the two outcomes are indistinguishable — a
# green CI run would mean either "the Docker executor works" or "nothing here ever ran it", and
# the second is exactly the state this whole feature was merged out of.
REQUIRE_DAEMON="${SMOKE_DOCKER_REQUIRED:-}"

# Every container this run creates carries this as `solow.workspace`, so cleanup can find them by
# asking the daemon rather than by remembering names — a container the probe created and then
# crashed before reporting is exactly the one that would otherwise be left running.
WORKSPACE="smoke-$$-$(od -An -N4 -tx4 < /dev/urandom | tr -d ' \n')"

WORK="$(mktemp -d)"
PROBE_PID=""

cleanup() {
    status=$?
    if [ -n "$PROBE_PID" ]; then
        kill -TERM "$PROBE_PID" 2> /dev/null || true
        wait "$PROBE_PID" 2> /dev/null || true
    fi
    # By label, and unconditionally: `dispose()` is one of the things under test, so this must not
    # assume it ran or worked. `docker rm -f` on an already-removed container succeeds.
    leftover="$(docker ps -aq --filter "label=solow.workspace=$WORKSPACE" 2> /dev/null || true)"
    if [ -n "$leftover" ]; then
        echo "$leftover" | xargs docker rm -f > /dev/null 2>&1 || true
    fi
    # And the deliberately unusable image the preflight block imports, on the same terms and for
    # the same reason: it is named after this run, and a block that failed before removing it
    # would otherwise leave one behind on every red run.
    docker image rm -f "solow-t-broken:$WORKSPACE" > /dev/null 2>&1 || true
    if [ "$status" -ne 0 ] && [ -f "$WORK/probe.log" ]; then
        echo
        echo "--- probe output ---"
        cat "$WORK/probe.log"
    fi
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT INT TERM

# No daemon is the one cause that is allowed to end this run early, and `SMOKE_DOCKER_REQUIRED`
# decides which way. On a developer's machine a skip: a red gate that means "no Docker here"
# trains people to ignore a red gate. Where this is a merge gate, a failure: the six questions
# below are the only live evidence that the Docker executor works at all, and a run that asked
# none of them must not be able to report the same green as a run that asked all six.
#
# Anything else below is a real failure in either mode.
#
# stdout is discarded rather than kept, because `docker info` prints the whole client block
# before it gets anywhere near the problem, and a skip whose reason is three lines of version
# numbers is a skip nobody reads. The diagnosis is on stderr, by itself.
if ! docker info > /dev/null 2> "$WORK/info.log"; then
    if [ -n "$REQUIRE_DAEMON" ] && [ "$REQUIRE_DAEMON" != "0" ]; then
        {
            echo "smoke-docker-executor FAILED — SMOKE_DOCKER_REQUIRED is set and no Docker daemon is reachable."
            echo "This gate is the only live proof the Docker executor works; skipping it here would"
            echo "report the same green as a run that proved it. Give the job a daemon, or unset"
            echo "SMOKE_DOCKER_REQUIRED if this host is deliberately not expected to have one:"
            sed 's/^/    /' "$WORK/info.log"
        } >&2
        exit 1
    fi
    echo "smoke-docker-executor SKIPPED — no reachable Docker daemon:"
    sed 's/^/    /' "$WORK/info.log"
    exit 0
fi

echo "==> daemon $(docker version --format '{{.Server.Version}}'), image $IMAGE"
# Pulled up front so a registry problem is reported as one, rather than surfacing later as
# "AC-6 failed: the image that was supposed to work did not pull either".
docker image inspect "$IMAGE" > /dev/null 2>&1 || docker pull -q "$IMAGE" > /dev/null || {
    echo "smoke-docker-executor: could not pull $IMAGE — set SMOKE_DOCKER_IMAGE to one this host can reach." >&2
    exit 1
}

# Generated here and never in an argv or an environment: AC-3 asks whether the host can see this
# string, so a run that put it on a command line would be asking a question it had already
# answered wrong. The probe reads it from the file; the greps below match against the file with
# `-f`, for the same reason.
(umask 077 && od -An -N24 -tx1 < /dev/urandom | tr -d ' \n' > "$WORK/secret")

echo "==> driving the driver (workspace $WORKSPACE)"
# The driver half, as a Bun program, because the driver is one. Written into the scratch
# directory rather than kept in `apps/`: it is not a unit test, `bun test` must not collect it,
# and a gate that leaves files in the source tree is a gate people stop running. It imports the
# production modules by absolute path, so this exercises the shipped driver and not a copy.
cat > "$WORK/probe.ts" << 'PROBE'
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [root, work, workspace, image] = process.argv.slice(2);

// Dynamic, because the repository root is an argument: the alternative is interpolating it into
// the heredoc above, which would stop the shell quoting it and let the driver's own `${...}`
// template literals be eaten by the shell.
const { createDockerExecutor, defaultContainerUser, isExecutorUnavailable } = await import(
  join(root, "apps/orchestrator/src/executor/docker.js")
);
const { createLocalExecutor } = await import(join(root, "apps/orchestrator/src/executor/local.js"));
// The lifecycle's own answer to "what may this container see", imported rather than restated.
// A mount set written out here would prove that *this file's* idea of isolation isolates, which
// is the one thing nobody needs to know — and it is a derived answer, so a second copy of the
// derivation is a second thing to keep in step with `worktreePath` and `taskRepositoryPath`.
const { executorBindPaths } = await import(
  join(root, "apps/orchestrator/src/inngest/functions/task-run.js")
);

function fail(why) {
  console.error(`smoke-docker-executor: ${why}`);
  process.exit(1);
}
const ok = (what) => console.log(`ok   ${what}`);

// The two roots a deployment owns — `SOLOW_WORKTREE_ROOT` and `SOLOW_REPO_CACHE_ROOT`. Both are
// named, because both are what a real Task's paths are derived from and what the mount-source
// guard measures them against; a probe that invented one directory would be describing a
// deployment layout nothing ships.
const worktreeRoot = await mkdtemp(join(tmpdir(), "solow-smoke-docker-"));
const repoCacheRoot = await mkdtemp(join(tmpdir(), "solow-smoke-cache-"));

// The Repository *both* Tasks below are attached to, and the directory a deployment shares
// between them. It is deliberately inside the cache root, which is a root the guard would allow
// a mount from: so when the containers cannot reach it, that is the mount set saying no and not
// `guardMountSource` — two different mechanisms, and only one of them is AC-2.
const sharedRepo = join(repoCacheRoot, "shared-repository");
await mkdir(sharedRepo, { recursive: true });
await writeFile(join(sharedRepo, "CANARY"), "the deployment's shared clone\n");
// Handed to the host half, which asks the daemon whether this path is in any mount set at all.
await writeFile(join(work, "shared-repo"), sharedRepo);

// One `local_path` Repository, and every Task below attached to it — the case the isolation
// defect was in, and the only case where "each Task sees its own directories" says anything: two
// Tasks on two different Repositories have nothing to share by accident.
const repositories = [
  {
    attachment: { id: "smoke-attachment", position: 0 },
    repository: { source: "local_path", location: sharedRepo },
  },
];

// A real local executor as the host, exactly as `dockerHost()` builds in production. A fake here
// would put back the stand-in this whole file exists to remove.
const host = createLocalExecutor(process.cwd());
const base = { kind: "docker", image, mounts: [], env: {} };
const made = [];

async function executorFor(taskId, config) {
  // `ownClone` is `true` because the lifecycle sets it from `config.kind !== "local"`, and every
  // executor here is a container one. That is the flag that decides whether the parent repository
  // in the mount set is this Task's own clone or the one the deployment shares — so passing it
  // the way the lifecycle passes it is most of what makes this probe worth running.
  const bindPaths = executorBindPaths({ worktreeRoot, repoCacheRoot }, taskId, repositories, true);
  const [jailRoot, ownRepo] = bindPaths;
  // Not an acceptance criterion — a guard on the probe. A `bindPaths` that came back some other
  // shape would leave every refusal below passing for the wrong reason.
  if (bindPaths.length !== 2) {
    fail(`a one-Repository Task was given ${bindPaths.length} bind paths: ${JSON.stringify(bindPaths)}`);
  }
  await mkdir(jailRoot, { recursive: true });
  await mkdir(ownRepo, { recursive: true });
  const executor = createDockerExecutor(
    host,
    config,
    { workspaceId: workspace, taskId, sessionId: "smoke" },
    { jailRoot, worktreeRoot, repoCacheRoot, bindPaths, user: defaultContainerUser() },
  );
  made.push(executor);
  return { executor, jailRoot, ownRepo };
}

/* AC-6 — an unpullable image fails with a legible reason, before anything starts. */
const absentImage = `solow-smoke-absent:${workspace}`;
const absent = await executorFor("nosuchimage", { ...base, image: absentImage });
let refusal;
try {
  await absent.executor.exec(["true"]);
} catch (cause) {
  refusal = cause;
}
if (refusal === undefined) fail("an executor on an unpullable image ran a command anyway");
if (!isExecutorUnavailable(refusal)) {
  fail(`an unpullable image threw ${refusal?.constructor?.name} — the lifecycle cannot tell it apart from the command saying no`);
}
// The reason has to survive to the message, not just the class: a card reading "could not start
// the executor container — " with nothing after the dash is the failure `failureText` exists for.
// Both halves are asked, because either alone passes on a useless message — a bare daemon phrase
// tells the Owner nothing about *which* profile, and the image name alone is already on the card.
if (!refusal.message.includes(absentImage)) {
  fail(`an unpullable image failed without naming it: ${JSON.stringify(refusal.message)}`);
}
// And it has to be docker's *diagnosis*, not the notice above it. `docker run` narrates before
// it asks the registry, and both lines land on stderr in this order (verified on 29.7.2):
//
//     Unable to find image 'solow-smoke-absent:…' locally
//     docker: Error response from daemon: pull access denied for solow-smoke-absent, …
//
// The first line is true of *every* image the first time it is used, so an Owner told only that
// learns nothing — least of all whether to fix a typo, a tag, or a registry credential. This
// used to accept it, which meant the driver reporting `firstLine` passed. `diagnosisLine` in
// the driver is what makes the pair below hold: the notice is refused by name, and a phrase
// from the sentence underneath it is required.
if (/unable to find image/i.test(refusal.message)) {
  fail(`an unpullable image was reported with docker's pre-pull notice instead of its diagnosis: ${JSON.stringify(refusal.message)}`);
}
if (!/(error response from daemon|pull access denied|manifest unknown|repository does not exist|not found|no such image|invalid reference format)/i.test(refusal.message)) {
  fail(`an unpullable image failed without saying why: ${JSON.stringify(refusal.message)}`);
}
ok(`AC-6  unpullable image refused: ${refusal.message}`);

/* AC-5 — a memory ceiling the kernel enforces, not one that is merely on the command line. */
const LIMIT_MB = 64;
const CPU_LIMIT = 0.5;
const limited = await executorFor("limits", { ...base, memoryMb: LIMIT_MB, cpus: CPU_LIMIT });
const ceiling = await limited.executor.exec([
  "sh",
  "-c",
  "cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null",
]);
if (ceiling.stdout.trim() !== String(LIMIT_MB * 1024 * 1024)) {
  fail(`memoryMb ${LIMIT_MB} produced a cgroup ceiling of ${JSON.stringify(ceiling.stdout.trim())}`);
}
// Doubling a shell variable rather than `dd`: it touches every page it allocates, so the kernel
// has to act on the limit instead of handing back memory it has overcommitted. 16 bytes doubled
// 30 times is 16 GiB, which no plausible host absorbs by accident.
const balloon = await limited.executor.exec([
  "sh",
  "-c",
  's=0123456789abcdef; i=0; while [ $i -lt 30 ]; do s="$s$s"; i=$((i+1)); done; echo "ALLOCATED ${#s}"',
]);
if (balloon.exitCode === 0 || balloon.stdout.includes("ALLOCATED")) {
  fail(`a ${LIMIT_MB} MiB container allocated 16 GiB (exit ${balloon.exitCode}) — the ceiling is declared but not enforced`);
}
// The kill has to land on the process, not the container: an OOM that took the Task's container
// down would fail the run for a reason the agent could not see and the reaper could not explain.
const survived = await limited.executor.exec(["echo", "alive"]);
if (survived.stdout.trim() !== "alive") {
  fail(`the container did not survive its own OOM kill: ${JSON.stringify(survived.stderr.trim())}`);
}
ok(`AC-5  ${LIMIT_MB} MiB enforced — 16 GiB allocation killed with ${balloon.exitCode}, container still up`);

/*
 * AC-5's other half, which nothing else in the suite asks at all. The memory ceiling is proved
 * twice over — the cgroup file and an OOM kill — while `--cpus` had only an exact-argv
 * comparison in `docker.test.ts` behind it, and an argv comparison cannot tell a flag the daemon
 * honours from one it silently drops.
 *
 * So the same two questions memory gets: what the kernel wrote down, and the kernel acting on
 * it. `cpu.max` is "<quota> <period>" in microseconds against one CPU, so `--cpus 0.5` is
 * "50000 100000" (verified live on 29.7.2), and `nr_throttled` counts the periods this cgroup
 * was actually stopped in for running out of quota — the throttle equivalent of the OOM kill.
 * cgroup v1 spells both differently and is read as a fallback, exactly as the memory check does.
 */
const CPU_QUOTA = `${Math.round(CPU_LIMIT * 100_000)} 100000`;
const quota = await limited.executor.exec([
  "sh",
  "-c",
  "cat /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null",
]);
if (quota.stdout.trim().split(/\s+/).join(" ") !== CPU_QUOTA) {
  fail(`cpus ${CPU_LIMIT} produced a cgroup quota of ${JSON.stringify(quota.stdout.trim())}, expected ${JSON.stringify(CPU_QUOTA)}`);
}
// Bounded by the wall clock rather than by an iteration count: under half a CPU a fixed amount
// of work takes an unbounded amount of time on a machine nobody has measured, and this has to
// run in a merge gate. The counter is read either side of the loop because a container that has
// already run three commands is not necessarily sitting at zero.
const SPIN_SECONDS = 3;
const throttle = await limited.executor.exec([
  "sh",
  "-c",
  'n() { grep -h nr_throttled /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/cpu/cpu.stat 2>/dev/null | head -n 1 | cut -d" " -f2; };' +
    ` before=$(n); end=$(( $(date +%s) + ${SPIN_SECONDS} ));` +
    ' while [ "$(date +%s)" -lt "$end" ]; do :; done; echo "$before $(n)"',
]);
const [before, after] = throttle.stdout.trim().split(/\s+/).map(Number);
if (!Number.isFinite(before) || !Number.isFinite(after)) {
  fail(`the container could not read its own cpu.stat: ${JSON.stringify(throttle.stdout.trim())}`);
}
if (after <= before) {
  fail(`${SPIN_SECONDS}s of a busy loop under ${CPU_LIMIT} CPU was never throttled (nr_throttled ${before} then ${after}) — the quota is on the command line but not enforced`);
}
ok(`AC-5  ${CPU_LIMIT} CPU enforced — cpu.max "${CPU_QUOTA}", and the kernel throttled ${after - before} periods in ${SPIN_SECONDS}s`);

/* AC-2 — two Tasks on one Repository, each holding only its own directories. */
const a = await executorFor("agent", base);
const b = await executorFor("peer", base);
await a.executor.fs.writeFile("secret.txt", "task-a private\n");
await b.executor.fs.writeFile("own.txt", "task-b private\n");
// Both controls first. Without them a `cat` that fails for every path would pass the real check
// below while proving nothing at all.
if ((await a.executor.fs.readFile("secret.txt")).trim() !== "task-a private") {
  fail("the first executor could not read back its own file — the rest of AC-2 would prove nothing");
}
if ((await b.executor.fs.readFile("own.txt")).trim() !== "task-b private") {
  fail("the second executor could not read back its own file — the rest of AC-2 would prove nothing");
}
// The third control, and the one the production mount set adds: the *other* half of each Task's
// pair — its own clone of the shared Repository, the directory its worktree's `.git` file points
// at — is mounted and readable. Every check below this line is a refusal, and refusals from a
// container that was given no mounts at all would all pass while proving the opposite.
await writeFile(join(a.ownRepo, "OWN"), "task-a clone\n");
const ownRepoVisible = await a.executor.exec(["cat", join(a.ownRepo, "OWN")]);
if (ownRepoVisible.exitCode !== 0 || !ownRepoVisible.stdout.includes("task-a clone")) {
  fail(`the Task's own repository clone is not mounted (exit ${ownRepoVisible.exitCode}) — the refusals below would prove nothing`);
}
// The real question, asked the way an agent would ask it: an absolute host path, `cat` inside the
// other container. The mounts are identical-path, so this is the same string that works in A.
const across = await b.executor.exec(["cat", join(a.jailRoot, "secret.txt")]);
if (across.exitCode === 0 || across.stdout.includes("task-a private")) {
  fail(`the second container read the first's worktree (exit ${across.exitCode}): ${JSON.stringify(across.stdout)}`);
}
// The same question about the other directory in the pair, which is the one `ownClone` exists
// for and the one the local-executor shape never had. A worktree's `.git` is a file pointing at
// its parent repository, so the parent has to be in the mount set or the worktree is not a git
// repository from inside the container at all — and while that parent was the clone the
// *deployment* shares, this read succeeded, with the other Task's objects, result branch and
// worktree registrations behind it.
const acrossRepo = await b.executor.exec(["cat", join(a.ownRepo, "OWN")]);
if (acrossRepo.exitCode === 0 || acrossRepo.stdout.includes("task-a clone")) {
  fail(`the second container read the first's repository clone (exit ${acrossRepo.exitCode}): ${JSON.stringify(acrossRepo.stdout)}`);
}
// And the shared clone itself, which is in neither mount set. `test -e`, so that a directory
// answers as plainly as a file would.
for (const [who, box] of [["agent", a], ["peer", b]]) {
  const shared = await box.executor.exec(["test", "-e", sharedRepo]);
  if (shared.exitCode === 0) {
    fail(`the ${who} container can see the Repository the deployment shares, at ${sharedRepo}`);
  }
}
// And the same question through `fs`, where the jail is enforced on the host before a path ever
// reaches a container. Both halves matter: one is a mount namespace, the other is arithmetic.
let escaped = false;
try {
  await b.executor.fs.readFile("../agent/secret.txt");
  escaped = true;
} catch {
  // The jail refusing is the pass.
}
if (escaped) fail("fs.readFile walked out of the executor root with ..");
ok(`AC-2  with the production mount set, the peer container reads neither the agent's worktree nor its clone of the Repository they share (exit ${across.exitCode}/${acrossRepo.exitCode}), and .. is refused`);

/* AC-1 and AC-3 — a live agent, its credential, and what the host can see of it. */
const secret = (await readFile(join(work, "secret"), "utf8")).trim();
// Shaped from the *image's* environment, which is what a containerised agent's caller must do:
// handing it the orchestrator's PATH and HOME describes a machine it is not running on.
const imageEnv = await a.executor.baseEnv();
const agent = a.executor.spawn(
  // `sleep 3417` is the marker the host half greps `docker top` for — distinctive enough that a
  // stray sleep on a busy machine cannot answer for it.
  ["/bin/sh", "-c", 'echo "HOSTNAME:$(cat /etc/hostname)"; echo "SECRET:$SMOKE_SECRET"; exec sleep 3417'],
  { cwd: a.jailRoot, env: { PATH: imageEnv.PATH, HOME: a.jailRoot, SMOKE_SECRET: secret } },
);

const said = new Map();
const decoder = new TextDecoder();
let buffered = "";
const readMarkers = (async () => {
  for await (const chunk of agent.stdout) {
    buffered += decoder.decode(chunk, { stream: true });
    for (const line of buffered.split("\n").slice(0, -1)) {
      const at = line.indexOf(":");
      if (at > 0) said.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
    if (said.has("HOSTNAME") && said.has("SECRET")) return;
  }
})();
await Promise.race([
  readMarkers,
  new Promise((_, reject) => setTimeout(() => reject(new Error("the agent said nothing in 60s")), 60_000)),
]).catch((cause) => fail(cause.message));

if (said.get("SECRET") !== secret) {
  // Never printed: a smoke test that echoes the credential it is checking for confinement would
  // put it in the CI log, which is one of the places AC-3 is about.
  fail("the credential in SpawnOpts.env did not reach the process inside the container");
}
if (!said.get("HOSTNAME")) fail("the agent could not report the hostname of its own UTS namespace");
// Handed to the host half rather than checked here: the container id is the daemon's answer, and
// this process has no business asking the daemon for it.
await writeFile(join(work, "agent-hostname"), said.get("HOSTNAME"));
ok("AC-3  the credential reached the process (the host half checks it went nowhere else)");
ok("AC-1  the agent is running and reported a UTS hostname (the host half settles whose)");

// The rendezvous. Everything above is done and the agent is still alive, which is the only state
// the host half can ask its questions in.
await writeFile(join(work, "live"), "");
for (let waited = 0; !existsSync(join(work, "go")); waited++) {
  if (waited > 2400) fail("the host half never finished");
  await new Promise((r) => setTimeout(r, 50));
}

/* AC-4 — dispose removes the container. Asked by the host half, after this exits. */
// Stopped the way the kill ladder stops a real agent, so dispose is not covering for a leak.
agent.kill();
await Promise.race([agent.exited, new Promise((r) => setTimeout(r, 10_000))]);
// Every executor, including the one whose image never pulled: `dispose()` must be safe on a
// container that was never created, because that is the path a failed preflight takes.
for (const executor of made) await executor.dispose();
PROBE

bun "$WORK/probe.ts" "$ROOT" "$WORK" "$WORKSPACE" "$IMAGE" > "$WORK/probe.log" 2>&1 &
PROBE_PID=$!

waited=0
while [ ! -f "$WORK/live" ]; do
    if ! kill -0 "$PROBE_PID" 2> /dev/null; then
        echo "smoke-docker-executor: the driver probe exited before the agent was up." >&2
        exit 1
    fi
    [ "$waited" -lt "$PROBE_TIMEOUT" ] || {
        echo "smoke-docker-executor: the driver probe did not reach a live agent within ${PROBE_TIMEOUT}s." >&2
        exit 1
    }
    sleep 1
    waited=$((waited + 1))
done
sed 's/^/    /' "$WORK/probe.log"

echo "==> what the host can see"

AGENT="$(docker ps -q --filter "label=solow.workspace=$WORKSPACE" --filter "label=solow.task=agent")"
[ -n "$AGENT" ] || {
    echo "smoke-docker-executor: no running container carries this run's agent labels." >&2
    exit 1
}

# AC-6's other half. Three containers is the whole population: agent, peer, limits. A fourth means
# the unpullable image got as far as creating something, which is the "before anything starts"
# part of the claim — and a container nobody can ever exec into is one the reaper has to explain.
CREATED="$(docker ps -aq --filter "label=solow.workspace=$WORKSPACE" | wc -l | tr -d ' ')"
[ "$CREATED" = "3" ] || {
    echo "smoke-docker-executor: this run created $CREATED containers, expected 3 — the unpullable image left one behind." >&2
    exit 1
}
echo "    ok   AC-6  the unpullable image created no container"

# AC-1, asked of the daemon rather than of the process. The host's own `ps` cannot answer this:
# container processes are visible in it, so finding `sleep 3417` there would prove nothing about
# which namespace it is in. `docker top` is the daemon saying the process belongs to this
# container, and the UTS hostname the agent reported is that container's id — which nothing on
# the host could have handed it.
docker top "$AGENT" -o pid,args 2> /dev/null | grep -q 'sleep 3417' || {
    echo "smoke-docker-executor: the daemon does not list the agent as a process of its container." >&2
    exit 1
}
case "$(docker inspect -f '{{.Id}}' "$AGENT")" in
    "$(cat "$WORK/agent-hostname")"*) ;;
    *)
        echo "smoke-docker-executor: the agent's UTS hostname is not this container's id — it is not running where the driver says." >&2
        exit 1
        ;;
esac
echo "    ok   AC-1  the daemon lists the agent in its container, whose id is the agent's hostname"

# AC-3's other two thirds. `-f "$WORK/secret"` rather than the value: this script must not put the
# credential in an argv either, or it would be manufacturing the leak it is checking for.
docker ps -aq --filter "label=solow.workspace=$WORKSPACE" | xargs docker inspect > "$WORK/inspect.json"
if grep -F -q -f "$WORK/secret" "$WORK/inspect.json"; then
    echo "smoke-docker-executor: the credential is in 'docker inspect' — anyone on this daemon can read it." >&2
    exit 1
fi
# Full argv of every process on the host, which is where `-e KEY=VALUE` would have put it.
ps -ww -A -o args= > "$WORK/ps.txt" 2> /dev/null
if grep -F -q -f "$WORK/secret" "$WORK/ps.txt"; then
    echo "smoke-docker-executor: the credential is in the host's ps output." >&2
    exit 1
fi
echo "    ok   AC-3  the credential is in neither 'docker inspect' nor the host's ps"

# AC-2 asked of the daemon rather than of a container, reusing the inspect above: the Repository
# both Tasks are attached to must not appear in any container's mount set at all. The reads
# inside the containers prove the shared clone is unreachable; this proves it was never offered.
# They are different failures — a mount set that regains the shared clone would still be
# unreadable for as long as nothing wrote to it, and would then quietly stop being so.
if grep -F -q -f "$WORK/shared-repo" "$WORK/inspect.json"; then
    echo "smoke-docker-executor: the Repository the deployment shares is in a container's mount set." >&2
    exit 1
fi
echo "    ok   AC-2  the shared Repository is in no container's mount set"

# Releases the probe, which kills the agent and calls dispose() on all four executors.
: > "$WORK/go"
if ! wait "$PROBE_PID"; then
    PROBE_PID=""
    echo "smoke-docker-executor: the driver probe failed during teardown." >&2
    exit 1
fi
PROBE_PID=""

echo "==> after dispose()"
REMAINING="$(docker ps -aq --filter "label=solow.workspace=$WORKSPACE")"
[ -z "$REMAINING" ] || {
    echo "smoke-docker-executor: dispose() left containers behind:" >&2
    docker ps -a --filter "label=solow.workspace=$WORKSPACE" --format '    {{.ID}} {{.Names}} {{.Status}}' >&2
    exit 1
}
echo "    ok   AC-4  every container this run created is gone"

# The three halves of the acceptance criteria the six blocks above never reach. Each one runs its
# own short Bun program rather than being folded into the probe: the probe holds a live agent open
# across a rendezvous so the host half can ask the daemon about it, and every question below is
# asked *after* something has ended — a preflight that refused, a run that finished, an
# orchestrator that died. Sharing one process would mean either widening that rendezvous into a
# state machine or asserting about containers while the agent's are still up, and the container
# census in AC-6 below is only meaningful when nothing else this run made is running.
#
# All of them carry `solow.workspace=$WORKSPACE`, so `cleanup` removes whatever they leave behind
# whichever line the script died on.

echo "==> AC-6  the preflight ladder itself, against this daemon"
# `probeExecutor` is what fails a Task *before* an agent exists, and its verdict is the whole of
# what an operator reads on the card. The AC-6 block above drives the driver (`ensureContainer` →
# `docker run`); nothing anywhere drives the ladder's own rungs, and the defect class that lives
# exactly there is misdiagnosis — an image with no `/bin/sh` reported as a host with no Docker
# sends someone to install a daemon that is already answering. So four rungs are broken in turn,
# and what is asserted is that the four reasons are *different from each other* and that each one
# names its own subsystem.

# The broken image: present, inspectable, and with nothing inside it — `docker import` of an
# empty directory, which costs one round trip where a `docker build` would cost a builder and a
# network. This is the rung that has to be told apart from "Docker is not installed".
BROKEN_IMAGE="solow-t-broken:$WORKSPACE"
mkdir -p "$WORK/empty-image" "$WORK/no-docker"
tar -cf - -C "$WORK/empty-image" . | docker import - "$BROKEN_IMAGE" > /dev/null || {
    echo "smoke-docker-executor: could not import the empty image the broken-image rung needs." >&2
    exit 1
}

# `bun` by absolute path, because one of the rungs below runs with a `PATH` that has nothing on
# it at all — including bun.
BUN="$(command -v bun)"

cat > "$WORK/preflight.ts" << 'PREFLIGHT'
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [root, work, workspace, rung, image] = process.argv.slice(2);

const { defaultContainerUser } = await import(
  join(root, "apps/orchestrator/src/executor/docker.js")
);
const { createLocalExecutor } = await import(join(root, "apps/orchestrator/src/executor/local.js"));
const { probeExecutor } = await import(join(root, "apps/orchestrator/src/executor/preflight.js"));

// Under the scratch directory the shell owns rather than a fresh `mkdtemp`, so `cleanup` takes
// these with it on every exit path — including the ones where this program is what failed.
const worktreeRoot = join(work, `pf-${rung}-worktrees`);
const repoCacheRoot = join(work, `pf-${rung}-repos`);
const jailRoot = join(worktreeRoot, rung);
await mkdir(jailRoot, { recursive: true });
await mkdir(repoCacheRoot, { recursive: true });

const result = await probeExecutor(
  // The real local executor, as everywhere else here: the two rungs about a broken *host* are
  // broken in this process's own environment by the shell that started it, so a stand-in host
  // would be answering with its own idea of what those failures look like — which is the
  // opinion that was wrong in the first place.
  createLocalExecutor(process.cwd()),
  { kind: "docker", image, mounts: [], env: {} },
  { workspaceId: workspace, taskId: `preflight-${rung}`, sessionId: "smoke" },
  { jailRoot, worktreeRoot, repoCacheRoot, user: defaultContainerUser() },
);

// One line, and a trailing newline. Both matter: the shell counts these four files for
// distinctness with `cat | sort -u`, where a reason that arrived wrapped would be several
// "reasons" and four files without terminators would be one.
const reason = (result.ok ? "" : result.reason).replace(/\s+/g, " ").trim();
await writeFile(join(work, `pf-${rung}.verdict`), result.ok ? "ok" : "failed");
await writeFile(join(work, `pf-${rung}.reason`), `${reason}\n`);
console.log(`ok   AC-6  ${rung}: ${result.ok ? "the ladder passed" : reason}`);
PREFLIGHT

# Each rung in its own process, with the breakage in the environment it *starts* with. Bun
# snapshots the environment at process start, so assigning `process.env.DOCKER_HOST` inside the
# program does not reach the `docker` the host executor spawns — verified here, where it left two
# rungs quietly reporting the same healthy-host verdict and the block passing for no reason. It
# is also the truer shape: a host with no `docker` on `PATH` is a host, not a variable.
{
    DOCKER_HOST=unix:///nonexistent "$BUN" "$WORK/preflight.ts" "$ROOT" "$WORK" "$WORKSPACE" unreachable "$IMAGE" &&
        PATH="$WORK/no-docker" "$BUN" "$WORK/preflight.ts" "$ROOT" "$WORK" "$WORKSPACE" nodocker "$IMAGE" &&
        "$BUN" "$WORK/preflight.ts" "$ROOT" "$WORK" "$WORKSPACE" unpullable "solow-smoke-absent:$WORKSPACE" &&
        "$BUN" "$WORK/preflight.ts" "$ROOT" "$WORK" "$WORKSPACE" broken "$BROKEN_IMAGE" &&
        "$BUN" "$WORK/preflight.ts" "$ROOT" "$WORK" "$WORKSPACE" usable "$IMAGE"
} > "$WORK/preflight.log" 2>&1 || {
    sed 's/^/    /' "$WORK/preflight.log"
    echo "smoke-docker-executor: a preflight rung could not be driven at all." >&2
    exit 1
}
sed 's/^/    /' "$WORK/preflight.log"

# The two phrases an operator acts on, and the two that must never be said about the wrong
# subsystem: one sends them to install Docker, the other to go and start it.
NO_DOCKER='command was not found|not available on this host'
NO_DAEMON='not reachable'

for rung in unreachable nodocker unpullable broken; do
    [ "$(cat "$WORK/pf-$rung.verdict")" = "failed" ] || {
        echo "smoke-docker-executor: the preflight passed the $rung rung." >&2
        exit 1
    }
done

# `sort -u`, because "each rung fails" is satisfied by a ladder that answers the same sentence
# four times — and answering the same sentence four times *is* the misdiagnosis this block exists
# for, not a milder version of it.
DISTINCT="$(cat "$WORK/pf-unreachable.reason" "$WORK/pf-nodocker.reason" \
    "$WORK/pf-unpullable.reason" "$WORK/pf-broken.reason" | sort -u | wc -l | tr -d ' ')"
[ "$DISTINCT" = "4" ] || {
    echo "smoke-docker-executor: the four broken rungs gave $DISTINCT distinct reasons, not 4:" >&2
    sed 's/^/    /' "$WORK"/pf-*.reason >&2
    exit 1
}

check_reason() {
    _rung="$1"
    _pattern="$2"
    _want="$3"
    if grep -Eqi "$_pattern" "$WORK/pf-$_rung.reason"; then _got=yes; else _got=no; fi
    [ "$_got" = "$_want" ] || {
        echo "smoke-docker-executor: the $_rung rung reported:" >&2
        sed 's/^/    /' "$WORK/pf-$_rung.reason" >&2
        echo "  and /$_pattern/ should have matched: $_want (it was: $_got)." >&2
        exit 1
    }
}

# A socket that is not there is a daemon problem, not a client one: an operator told to install
# Docker on a host whose `docker` binary is right there has been sent to the wrong place.
check_reason unreachable "$NO_DAEMON" yes
check_reason unreachable "$NO_DOCKER" no
check_reason nodocker "$NO_DOCKER" yes
# The image has to be named, for the same reason the AC-6 block above requires it: the card says
# which profile failed as well as why, and "could not obtain image" alone is true of every
# registry problem there has ever been.
grep -Fq "solow-smoke-absent:$WORKSPACE" "$WORK/pf-unpullable.reason" || {
    echo "smoke-docker-executor: an unpullable image failed without naming it:" >&2
    sed 's/^/    /' "$WORK/pf-unpullable.reason" >&2
    exit 1
}
check_reason unpullable "could not obtain image" yes
check_reason unpullable "$NO_DOCKER" no
check_reason unpullable "$NO_DAEMON" no
# The pair the original blocker was about. This image exists and the daemon has it; what it
# lacks is `/bin/sh`, so the container is created and dies inside `runc` — quoting words the
# *image* chose, which include "No such file or directory": the same sentence that means "install Docker"
# when it is the spawn of the client that failed.
check_reason broken "$NO_DOCKER" no
check_reason broken "$NO_DAEMON" no
grep -Fq "$BROKEN_IMAGE" "$WORK/pf-broken.reason" || {
    echo "smoke-docker-executor: an unusable image failed without naming it:" >&2
    sed 's/^/    /' "$WORK/pf-broken.reason" >&2
    exit 1
}
# The control, and it is not decoration: four assertions that a rung *failed* all pass on a ladder
# that fails unconditionally. This rung has a reachable daemon, a `docker` on `PATH` and an image
# the daemon already holds. It is deliberately not required to pass — `alpine:3` has no `git` and
# rung 8 is right to say so — but whatever it says may not blame the daemon, the client, the
# registry or the container's start-up for that.
check_reason usable "$NO_DOCKER" no
check_reason usable "$NO_DAEMON" no
check_reason usable "could not obtain image" no
check_reason usable "exited immediately" no

# And the daemon's own half of it: a preflight that has returned a verdict must not have left a
# container behind at all. Nothing else this run created survives at this point, so this census is
# the whole population.
#
# `docker ps -aq`, not `-q`, and the difference is the whole assertion. The invariant
# `ensureContainer` states is that a failed preflight leaves *nothing* behind, but a running-only
# census asks the weaker question, and the gap is reachable: removing `--init` from `runArgs`
# makes the broken-image rung leak a container in state `Created`, which never appears in
# `docker ps` and so passed this block while the leak it exists to catch was happening. A
# `Created` container holds its CPU and memory reservation exactly as a running one does.
LEFTOVER="$(docker ps -aq --filter "label=solow.workspace=$WORKSPACE")"
[ -z "$LEFTOVER" ] || {
    echo "smoke-docker-executor: a preflight that failed left a container behind:" >&2
    docker ps -a --filter "label=solow.workspace=$WORKSPACE" --format '    {{.ID}} {{.Names}} {{.Status}}' >&2
    exit 1
}
echo "    ok   AC-6  four broken rungs, four different reasons, and none of them left a container behind"

echo "==> AC-3  the credential, after the run is over"
# The block above proves the value is in neither `docker inspect` nor the host's `ps` — both
# questions about the *running* system. This is the other half: what is left on disk once the
# container is gone. The worktree bind mount is deliberately preserved on failure so an operator
# can read what the agent did, so anything a credential-caching tool wrote into it outlives the
# Task by design, and `$HOME` is where every such tool writes — `.gitconfig`, `.npmrc`,
# `~/.config/gh/hosts.yml`, an agent CLI's own token store. `HOME` was moved onto a tmpfs for
# exactly that reason; this is the test that pins the decision to the kernel rather than to the
# comment that explains it.
cat > "$WORK/persist.ts" << 'PERSIST'
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [root, work, workspace, image] = process.argv.slice(2);

const { createDockerExecutor, defaultContainerUser } = await import(join(root, "apps/orchestrator/src/executor/docker.js"));
const { createLocalExecutor } = await import(join(root, "apps/orchestrator/src/executor/local.js"));

function fail(why) {
  console.error(`smoke-docker-executor: ${why}`);
  process.exit(1);
}
const ok = (what) => console.log(`ok   ${what}`);

// Under the scratch directory the shell owns, so `cleanup` removes both roots however this run
// ends — and so the host half below, which has to read the worktree *after* the container is
// gone, is reading something with a known lifetime rather than litter in the system temp.
const worktreeRoot = join(work, "persist-worktrees");
const repoCacheRoot = join(work, "persist-repos");
const jailRoot = join(worktreeRoot, "persist");
const ownRepo = join(repoCacheRoot, "persist-clone");
await mkdir(jailRoot, { recursive: true });
await mkdir(ownRepo, { recursive: true });

const host = createLocalExecutor(process.cwd());
const executor = createDockerExecutor(
  host,
  { kind: "docker", image, mounts: [], env: {} },
  { workspaceId: workspace, taskId: "persist", sessionId: "smoke" },
  {
    jailRoot,
    worktreeRoot,
    repoCacheRoot,
    bindPaths: [jailRoot, ownRepo],
    user: defaultContainerUser(),
  },
);

// One cheap exec first, because `spawn` is synchronous by the interface and can only *kick*
// container creation: a `docker exec` that reaches the daemon first answers "No such container"
// with an empty stdout, and this block would then read an empty stream and report a driver that
// stopped filling in `HOME`. In a real run `step.run("executor-preflight")` has already created
// the container in its own durable step; this stands in for that step.
const warm = await executor.exec(["true"]);
if (warm.exitCode !== 0) fail(`could not start a container from "${image}": ${warm.stderr.trim()}`);

// Read from the file the shell seeded, never from an argv — the same discipline as the block
// above, and for the same reason: a script that put the value on a command line would be
// manufacturing the leak it is checking for.
const secret = (await readFile(join(work, "secret"), "utf8")).trim();
const imageEnv = await executor.baseEnv();

/*
 * The whole of `baseEnv()` plus the credential, which is what the lifecycle passes: `agentEnv`
 * in `packages/core/src/billing.ts` copies every entry of the base environment into the child
 * and then adds the credential on top.
 *
 * The block above overrides `HOME` with the jail on purpose, because AC-1 needs a live agent
 * somewhere writable. Here the driver's own answer is the thing under test — `baseEnv` is where
 * `HOME` is decided, and it is the decision that moved it off the bind mount — so naming a
 * `HOME` here would answer this file's question with this file's own value.
 */
const agent = executor.spawn(
  [
    "/bin/sh",
    "-c",
    [
      'echo "HOME:$HOME"',
      // The kernel's answer, not the driver's: a bind mount and a tmpfs are indistinguishable
      // from inside a shell until you ask what is actually mounted there.
      `echo "HOMEFS:$(awk -v h="$HOME" '$2 == h { print $3 }' /proc/mounts | head -n 1)"`,
      // What a tool that caches a credential does, spelled the way they spell it.
      'mkdir -p "$HOME/.config/agent"',
      'printf %s "$SMOKE_SECRET" > "$HOME/.config/agent/token.json"',
      'printf %s "$SMOKE_SECRET" > "$HOME/.netrc"',
      'env > "$HOME/env-dump"',
      // The control, in the bind mount: something the container wrote that *must* survive, so
      // that "the secret is not in the worktree" cannot pass by the worktree being empty.
      `printf %s "the agent was here" > ${JSON.stringify(join(jailRoot, "AGENT-WROTE-THIS"))}`,
      'echo "DONE:1"',
    ].join("; "),
  ],
  { cwd: jailRoot, env: { ...imageEnv, SMOKE_SECRET: secret } },
);

const said = new Map();
let buffered = "";
const decoder = new TextDecoder();
// stderr is drained alongside, and only so a failure here can say *why*: a shell that could not
// write to its own HOME reports it there, and a block that read stdout alone would blame the
// driver for it.
const complaints = new Response(agent.stderr).text();
for await (const chunk of agent.stdout) {
  buffered += decoder.decode(chunk, { stream: true });
  for (const line of buffered.split("\n").slice(0, -1)) {
    const at = line.indexOf(":");
    if (at > 0) said.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
}
await agent.exited;

if (said.get("DONE") !== "1") {
  fail(
    `the agent did not finish writing its caches: ${JSON.stringify([...said])} / ${JSON.stringify((await complaints).trim())}`,
  );
}
const home = said.get("HOME");
if (!home) fail("the agent had no HOME at all — the driver stopped filling one in");
// The decision, stated as the two things that make it true. A `HOME` inside either root is a
// `HOME` on a host bind mount however it is spelled, and a `HOME` that is not a tmpfs survives
// into whatever the container's layer becomes.
if (home.startsWith(`${worktreeRoot}/`) || home === worktreeRoot) {
  fail(`the agent's HOME is inside the bind-mounted worktree root: ${home}`);
}
if (home.startsWith(`${repoCacheRoot}/`) || home === repoCacheRoot) {
  fail(`the agent's HOME is inside the bind-mounted repository cache: ${home}`);
}
if (said.get("HOMEFS") !== "tmpfs") {
  fail(`the agent's HOME is a ${JSON.stringify(said.get("HOMEFS"))} mount, not a tmpfs — what a tool caches there outlives the container`);
}
ok(`AC-3  HOME is ${home}, a tmpfs, and inside neither bind-mounted root`);

// The container goes, exactly as a finished run's does. Everything the host half asks is asked
// after this line, because "at rest" means after the run.
await executor.dispose();

await writeFile(join(work, "persist-roots"), `${worktreeRoot}\n${repoCacheRoot}\n`);
await writeFile(join(work, "persist-home"), home);
await writeFile(join(work, "persist-marker"), join(jailRoot, "AGENT-WROTE-THIS"));
ok("AC-3  the container is gone; the host half reads what it left");
PERSIST

if ! bun "$WORK/persist.ts" "$ROOT" "$WORK" "$WORKSPACE" "$IMAGE" > "$WORK/persist.log" 2>&1; then
    sed 's/^/    /' "$WORK/persist.log"
    echo "smoke-docker-executor: the credential-persistence run did not complete." >&2
    exit 1
fi
sed 's/^/    /' "$WORK/persist.log"

# The control first. Without it every refusal below passes on a worktree the container never
# reached, which is the same class of hole the AC-2 controls above exist to close.
MARKER="$(cat "$WORK/persist-marker")"
[ -s "$MARKER" ] || {
    echo "smoke-docker-executor: nothing the container wrote survived in the worktree — the searches below would prove nothing." >&2
    exit 1
}

# `-f "$WORK/secret"` and never the value, recursively over both roots the deployment owns: the
# worktree the bind mount preserves, and the repository cache the Task's own clone lives in.
while IFS= read -r dir; do
    [ -d "$dir" ] || continue
    if grep -r -F -q -f "$WORK/secret" "$dir" 2> /dev/null; then
        echo "smoke-docker-executor: the credential is at rest under $dir, after the container is gone:" >&2
        grep -r -F -l -f "$WORK/secret" "$dir" 2> /dev/null | sed 's/^/    /' >&2
        exit 1
    fi
    # And the same question by name rather than by content, which catches a cache that landed
    # here holding a *derived* token this script has no copy of to grep for.
    STRAYS="$(find "$dir" \( -name env-dump -o -name .netrc -o -name token.json \) -print 2> /dev/null)"
    [ -z "$STRAYS" ] || {
        echo "smoke-docker-executor: the agent's HOME caches were written onto the host under $dir:" >&2
        echo "$STRAYS" | sed 's/^/    /' >&2
        exit 1
    }
done < "$WORK/persist-roots"

# And `$HOME` as the container saw it, in case that path also exists on the host — a tmpfs at
# `/home/solow` inside the container says nothing about `/home/solow` out here.
CONTAINER_HOME_PATH="$(cat "$WORK/persist-home")"
if [ -e "$CONTAINER_HOME_PATH" ] && grep -r -F -q -f "$WORK/secret" "$CONTAINER_HOME_PATH" 2> /dev/null; then
    echo "smoke-docker-executor: the credential is at rest in $CONTAINER_HOME_PATH on the host." >&2
    exit 1
fi
echo "    ok   AC-3  after the run, the credential is in neither bind-mounted root nor the host's copy of \$HOME"

echo "==> AC-4  orphan reconciliation, against a simulated crash"
# The half of AC-4 nothing has ever driven live. `dispose()` is the tidy path and the block above
# proves it; the reaper is the path a *crash* takes, and issue #96's Definition of Done names
# "orphan reconciliation tested against a simulated crash" in those words.
#
# Two containers, identical in every respect the reaper can see except one: the epoch in
# `/run/solow/owner`. Same deployment, same labels, a Task row in `review` and a Session whose id
# matches the container's `solow.run` for both — so the sweep's verdict on each turns on the claim
# and on nothing else. That is what makes this a differential rather than two unrelated
# containers, and it is why both directions are asserted: a reaper that removes everything passes
# the first half, and round two's reaper defect was the one that destroyed live work.
cat > "$WORK/reap.ts" << 'REAP'
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const [root, work, workspace, image] = process.argv.slice(2);

// Before anything below is imported: `orchestratorEnv()` parses the environment once and caches
// it, and the reaper reads its deployment identity out of that cache. A root set afterwards
// would leave the sweep enumerating a different deployment than the one these containers are
// labelled for — which looks exactly like a reaper that found nothing.
const worktreeRoot = join(work, "reap-worktrees");
const repoCacheRoot = join(work, "reap-repos");
await mkdir(worktreeRoot, { recursive: true });
await mkdir(repoCacheRoot, { recursive: true });
process.env.SOLOW_WORKTREE_ROOT = worktreeRoot;
process.env.SOLOW_REPO_CACHE_ROOT = repoCacheRoot;
process.env.SOLOW_STREAM_SECRET ??= "smoke-stream-secret";

const { CONTAINER_OWNER_PATH, containerName, createDockerExecutor, defaultContainerUser, deploymentId } =
  await import(join(root, "apps/orchestrator/src/executor/docker.js"));
const { createLocalExecutor } = await import(join(root, "apps/orchestrator/src/executor/local.js"));
const { reapOrphanedContainers } = await import(join(root, "apps/orchestrator/src/executor/reap.js"));
const { RECLAIM_STALE_MS } = await import(join(root, "apps/orchestrator/src/reconcile.js"));
const { createTestDb } = await import(join(root, "packages/db/src/testing.js"));
const { agentCatalog, agentProfile, executorProfile, issue, session, task, workspace: workspaceTable } =
  await import(join(root, "packages/db/src/schema.js"));

function fail(why) {
  console.error(`smoke-docker-executor: ${why}`);
  process.exit(1);
}
const ok = (what) => console.log(`ok   ${what}`);

const host = createLocalExecutor(process.cwd());
const config = { kind: "docker", image, mounts: [], env: {} };
const deployment = deploymentId(worktreeRoot);

async function containerFor(taskId) {
  const jailRoot = join(worktreeRoot, taskId);
  await mkdir(jailRoot, { recursive: true });
  const ids = { workspaceId: workspace, taskId, sessionId: `sess-${taskId}` };
  const executor = createDockerExecutor(host, config, ids, {
    jailRoot,
    worktreeRoot,
    repoCacheRoot,
    bindPaths: [jailRoot],
    user: defaultContainerUser(),
  });
  // One cheap exec is what `step.run("executor-preflight")` does in a real run: it is what
  // creates the container and writes this process's epoch into it.
  const warm = await executor.exec(["true"]);
  if (warm.exitCode !== 0) fail(`could not create the ${taskId} container: ${warm.stderr.trim()}`);
  // Derived from the same function the driver names it with, never spelled out here — a second
  // copy of the naming rule is a second thing to keep in step with `containerName`.
  return { ids, name: containerName(ids, deployment) };
}

const orphan = await containerFor("reap-orphan");
const live = await containerFor("reap-live");

/*
 * The crash, and the whole of it.
 *
 * A crashed orchestrator leaves containers whose labels, Task rows and Sessions are all intact —
 * what it cannot leave is a live process, and `/run/solow/owner` is the only place that fact is
 * written down. Overwriting the file is therefore the *entire* difference between these two
 * containers, which is what makes the pair worth running: the sweep below has nothing else to
 * tell them apart with.
 */
const crashed = "0123456789abcdef";
const claimed = await host.exec([
  "docker",
  "exec",
  orphan.name,
  "sh",
  "-c",
  `echo ${crashed} > ${CONTAINER_OWNER_PATH}`,
]);
if (claimed.exitCode !== 0) fail(`could not rewrite the orphan's claim: ${claimed.stderr.trim()}`);
// Read back, because a write that silently failed would leave the orphan carrying *this*
// process's epoch — and the sweep would then be asked nothing at all while still passing.
const readback = await host.exec(["docker", "exec", orphan.name, "cat", CONTAINER_OWNER_PATH]);
if (readback.stdout.trim() !== crashed) {
  fail(`the orphan's claim did not take: ${JSON.stringify(readback.stdout.trim())}`);
}

// A real database with real migrations, because the reaper's evidence of life is read out of one
// with two joins and a state test. Rows that made both containers look *dead* would let a reaper
// that removes everything pass, so both Tasks are seeded the way a live run at the review gate
// leaves them: `review`, no failure reason, and the newest Session matching `solow.run`.
const db = createTestDb();
await db.insert(workspaceTable).values({ id: workspace, name: workspace, ownerUserId: "smoke" });
await db.insert(issue).values({ id: "iss-smoke", workspaceId: workspace, title: "smoke" });
await db.insert(agentCatalog).values({
  id: "cat-smoke",
  workspaceId: workspace,
  key: "claude_code",
  displayName: "Claude Code",
  protocol: "claude_code_stream_json",
  command: "claude",
  subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
  meteredEnvVar: "ANTHROPIC_API_KEY",
});
await db.insert(agentProfile).values({
  id: "ap-smoke",
  workspaceId: workspace,
  name: "Default",
  agentCatalogId: "cat-smoke",
  authMode: "subscription",
  secretId: "sec-smoke",
});
await db.insert(executorProfile).values({
  id: "ex-smoke",
  workspaceId: workspace,
  name: "Docker",
  kind: "docker",
  config,
});
for (const box of [orphan, live]) {
  await db.insert(task).values({
    id: box.ids.taskId,
    workspaceId: workspace,
    issueId: "iss-smoke",
    title: box.ids.taskId,
    state: "review",
    agentProfileId: "ap-smoke",
    executorProfileId: "ex-smoke",
  });
  await db.insert(session).values({
    id: box.ids.sessionId,
    workspaceId: workspace,
    taskId: box.ids.taskId,
  });
}

/*
 * The clock moves rather than the rows being back-dated, exactly as `reap.test.ts` does: the two
 * filters ahead of the claim are a creation grace and a quiet window measured from the Task row's
 * own `updatedAt`, and a row written a second ago is *supposed* to stop the sweep. Twenty minutes
 * on is past both, and it costs the gate nothing where sleeping through them would cost it ten.
 *
 * It is also what keeps the live container's survival meaningful. Left at real time, filter 3
 * would skip both containers and the sweep would prove only that it can be talked out of acting.
 */
const registry = { get: () => undefined };
const removed = await reapOrphanedContainers(
  host,
  db,
  registry,
  () => new Date(Date.now() + RECLAIM_STALE_MS * 2),
);
ok(`AC-4  the reaper swept and removed ${removed} of the two containers (the daemon settles which)`);
REAP

if ! bun "$WORK/reap.ts" "$ROOT" "$WORK" "$WORKSPACE" "$IMAGE" > "$WORK/reap.log" 2>&1; then
    sed 's/^/    /' "$WORK/reap.log"
    echo "smoke-docker-executor: the orphan-reconciliation run did not complete." >&2
    exit 1
fi
sed 's/^/    /' "$WORK/reap.log"

# Both halves asked of the daemon. The first is the one a reaper that does nothing fails; the
# second is the one a reaper that removes everything fails, and it is the expensive one to get
# wrong — a container removed out from under a run at the review gate takes the agent's exec with
# it and fails the round with no explanation an operator can see.
ORPHANED="$(docker ps -aq --filter "label=solow.workspace=$WORKSPACE" --filter "label=solow.task=reap-orphan")"
[ -z "$ORPHANED" ] || {
    echo "smoke-docker-executor: the reaper left a crashed orchestrator's container behind:" >&2
    docker ps -a --filter "label=solow.task=reap-orphan" --format '    {{.ID}} {{.Names}} {{.Status}}' >&2
    exit 1
}
SURVIVOR="$(docker ps -q --filter "label=solow.workspace=$WORKSPACE" --filter "label=solow.task=reap-live")"
[ -n "$SURVIVOR" ] || {
    echo "smoke-docker-executor: the reaper removed a live run's container — the one outcome it exists to avoid." >&2
    exit 1
}
echo "    ok   AC-4  the crashed orchestrator's container is gone and the live run's is still running"

echo
echo "smoke-docker-executor OK — the driver does on a live daemon what the brief says it does."
