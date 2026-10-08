# Running as a Service

**Status:** Draft · **Owner:** Operator · **Last reviewed:** 2026-10-08

What happens when one of SoloW's three services crashes, what happens to a run in flight, and how
to keep a long-running install up across logouts and reboots. Closes
[FINDINGS F2](../FINDINGS.md); the requirements are
[F16 FR-25 to FR-27](../features/F16-platform-deployment.md).

## A crashed service restarts on its own

Both launchers, `npx @satcomx00-x00/solow` and a checkout's `scripts/start.sh` and `scripts/dev.sh`,
run each of the three services under its own supervisor. When one exits:

- it is started again after 1 s, then 2 s, 4 s, 8 s and so on, up to 30 s;
- the other two keep running. Before this, any exit stopped the whole stack until someone noticed;
- the count resets once a run has lasted a minute, so a service that crashes once a day is always
  restarted;
- a service that fails five times in a row is treated as broken. The launcher then stops the
  other two and exits with status 1, so that a service manager above it, such as the systemd unit
  below, sees the failure rather than a stack that is half up.

The launcher log shows each restart:

```
[supervise] orchestrator exited (status 137) — restarting in 1s (attempt 1 of 5)
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOLOW_RESTART_LIMIT` | 5 | Failures in a row before the launcher gives up |
| `SOLOW_RESTART_STABLE_SECS` | 60 | A run this long resets the count |
| `SOLOW_RESTART_MAX_DELAY` | 30 | Longest wait between restarts, in seconds |

A clean stop (Ctrl-C, or `TERM` from a service manager) stops all three and exits 0. The launcher
holds `solow.pid` in the data folder while it runs, so a second launcher on the same folder, or a
[restore](./backup-and-restore.md), is refused.

## Runs in flight

What a run does when a service under it restarts. These are the recovery mechanisms the run engine
already had; the supervisor's part is to bring the service back quickly enough for them to work.

| Service that crashed | What happens to a run in flight |
| --- | --- |
| Web app | Nothing. It holds no run state. Open pages reconnect. |
| Orchestrator | The harness it started loses its pipes and normally exits. The engine's call into the orchestrator fails, and the engine retries the step once the orchestrator is back. The retried step resumes the harness's own conversation (`claude --resume`, or ACP `session/load`) in the same worktree. The first restart comes after 1 s, which is meant to land before the engine's retry, so that a retry is not spent on a closed port. The step has two retries. |
| Engine | Its database is on disk under `inngest/`, and the run continues from its last completed step when the engine is back. The engine's queue is kept in memory with periodic snapshots, so a crash can lose the last few seconds of it ([Decision 0004](../decisions/0004-durable-orchestration-engine.md)). A run lost that way leaves its Task showing as running; after 10 minutes of silence the reconciliation sweep relaunches it against the same Session, up to 3 times. |

Limits:

- Under the **Docker executor** a harness cannot resume its conversation: its home directory is
  discarded with the container, by design. The run starts a new conversation in the same worktree,
  and automatic continuation still applies.
- The orchestrator does not stop its harnesses when it is killed. One that ignores its closed pipes
  could keep running beside the retried step until it exits. This has not been seen, but nothing
  prevents it.
- The restart and the recovery steps above were each exercised on their own. A real harness run
  killed mid-round and resumed after a supervised restart has not been tested end to end.

## A long-running install with systemd

[`scripts/systemd/solow.service`](../../scripts/systemd/solow.service) is a user unit template:

```sh
mkdir -p ~/.config/systemd/user
cp scripts/systemd/solow.service ~/.config/systemd/user/
# edit ExecStart (npx version or checkout path) and PATH
systemctl --user daemon-reload
systemctl --user enable --now solow
loginctl enable-linger "$USER"     # start at boot, keep running after logout
journalctl --user -u solow -f      # the launcher's log
```

There are two layers of restart. The launcher restarts a single service; systemd restarts the whole
stack when the launcher gives up (`Restart=on-failure`), at most five times in ten minutes. After
that the unit shows as failed, which `systemctl --user status solow` reports.

`KillMode=mixed` sends `TERM` to the launcher alone, so it stops the services in order, and kills
anything left after 30 seconds. Pin the npm version in `ExecStart`: an upgrade migrates the
database, and it should happen when you choose. A copy is taken first; see
[Backup and Restore](./backup-and-restore.md).

Keep `SOLOW_BIND_HOST` at its loopback default unless the machine is behind a reverse proxy with
TLS ([F17](../features/F17-security-secrets.md)).
