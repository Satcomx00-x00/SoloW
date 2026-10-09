# The image the Docker executor runs a Task in (roadmap B4).
#
# The driver spawns the harness's bare command inside the container (`executor/docker.ts`), so
# isolation is only as available as an image with the harness in it. This one carries the two
# SoloW comes ready for — Claude Code and opencode — plus the userland the driver's preflight
# probes for (`REQUIRED_CONTAINER_UTILITIES`: sh, env, cat, find, mkdir, cp, test, df, base64 and
# git). Anything a particular repository needs beyond that is the Executor Profile's prepare
# script, which runs as root in the container before the harness starts.
#
# Built with no context — `make executor-image` or `solow executor-image` pipe this file to
# `docker build -` — so nothing from the checkout or the machine can end up in a layer. No
# credential is baked in either: the one a run needs arrives on each `docker exec`'s stdin.
#
# What the driver supplies at run time, and this image therefore must not fight:
#   - the user: `--user` is always the orchestrator's own uid:gid, so files written into the
#     bind-mounted worktree belong to someone the host can remove. The harnesses are installed
#     world-executable for that reason, and `solow` (1000:1000, the usual first account on a Linux
#     host) only gives that uid a name when it matches;
#   - `HOME`: a tmpfs at /home/solow (`CONTAINER_HOME`). No `ENV HOME` here, because an image that
#     declares one wins over the tmpfs (`baseEnv`), and a home that outlives the container is where
#     a harness's credential cache would survive the run.

# Two stages: npm is only how the harnesses are fetched, so it stays out of the image a harness
# runs in, and so does Node.
FROM node:22-trixie-slim AS harnesses

# Pinned, so a rebuild is the build it was last time. opencode's is the exact dependency the
# orchestrator and the published launcher ship, and the catalog's `minVersion`; the test
# `apps/orchestrator/src/executor/executor-image.test.ts` keeps the three in step. Claude Code
# has no catalog pin (stream-json names no build to check one against), so this is simply the
# release last chosen: raise it on purpose, not by rebuilding.
ARG CLAUDE_CODE_VERSION=2.1.289
ARG OPENCODE_VERSION=2.0.22

# Both packages ship their executable in a per-platform optional dependency and copy it over a
# placeholder in a postinstall, which npm runs here. Asking each one for its version proves the
# copy happened before the result is kept; `readlink -f` then takes the real file rather than the
# npm shim pointing at it.
RUN npm install --global --no-fund --no-audit --no-update-notifier \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@opencode/cli@${OPENCODE_VERSION}" \
    && claude --version \
    && opencode --version \
    && mkdir -p /harnesses \
    && cp "$(readlink -f "$(command -v claude)")" /harnesses/claude \
    && cp "$(readlink -f "$(command -v opencode)")" /harnesses/opencode \
    && chmod 0755 /harnesses/claude /harnesses/opencode

FROM debian:trixie-slim

ARG CLAUDE_CODE_VERSION=2.1.289
ARG OPENCODE_VERSION=2.0.22

LABEL org.opencontainers.image.title="solow-executor" \
      org.opencontainers.image.description="Where SoloW's Docker executor runs Claude Code and opencode" \
      org.opencontainers.image.source="https://github.com/Satcomx00-x00/SoloW" \
      org.opencontainers.image.licenses="Apache-2.0" \
      solow.harness.claude_code="${CLAUDE_CODE_VERSION}" \
      solow.harness.opencode="${OPENCODE_VERSION}"

# `procps` for its `kill` binary: the driver stops a harness with `docker exec <ctr> kill -s TERM
# <pid>`, which needs a real executable, and a slim Debian has only the shell builtin — a stop
# that silently did nothing. The preflight cannot see this (`command -v kill` finds the builtin).
#
# Not version-pinned (DL3008): the base tag fixes the Debian release, and pinning a package
# version inside it fails the build as soon as a security update replaces that version upstream.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git procps \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 solow \
    && useradd --uid 1000 --gid solow --create-home --home-dir /home/solow --shell /bin/sh solow

COPY --from=harnesses /harnesses/ /usr/local/bin/

# The install directory is root's and the harness runs as somebody else, so a self-update could
# only fail — or, run by hand as root, leave the image on a build nobody chose.
ENV DISABLE_AUTOUPDATER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1

# Numeric, as the driver passes it: a name is resolved against whichever passwd a tool reads.
USER 1000:1000
