#!/usr/bin/env bash
# Apply the GateControl issue-label taxonomy (colours + descriptions).
#
# Labels are created implicitly by the GitHub issues API and default to grey with
# no description. This script gives them their intended colour and meaning.
# Idempotent: creates a label if missing, updates it otherwise.
#
# Requires: gh (authenticated with repo scope)
# Usage:    scripts/labels.sh [owner/repo]      # defaults to the current repo

set -euo pipefail

REPO="${1:-}"
GH_ARGS=()
[ -n "$REPO" ] && GH_ARGS=(--repo "$REPO")

label() { # name colour description
  if gh label list "${GH_ARGS[@]}" --limit 200 --json name --jq '.[].name' | grep -qxF "$1"; then
    gh label edit "$1" "${GH_ARGS[@]}" --color "$2" --description "$3"
  else
    gh label create "$1" "${GH_ARGS[@]}" --color "$2" --description "$3"
  fi
}

# ── Priority ── red → grey, most urgent first
label "priority/P0-critical" "b60205" "Blocks other work, or protects a zero-tolerance invariant"
label "priority/P1-high"     "d93f0b" "Next after the P0 foundations"
label "priority/P2-medium"   "fbca04" "Valuable, not blocking"
label "priority/P3-low"      "c5def5" "Deferred; revisit when its prerequisites land"

# ── Kind ──
label "kind/foundation"  "5319e7" "Architectural work other issues depend on"
label "kind/feature"     "0e8a16" "New user-facing capability"
label "kind/enhancement" "84b6eb" "Improves something that already exists"
label "kind/infra"       "455a64" "Build, deploy, tooling, operations"
label "kind/meta"        "ededed" "Index, tracking, process"

# ── Area ──
for a in orchestration workflows board issues agents sessions review \
         executors repos security billing integrations mcp platform \
         observability ui api; do
  label "area/$a" "1d76db" "Subsystem: $a"
done

# ── Effort ──
label "effort/S"  "e4e669" "≤ 1 day"
label "effort/M"  "d4c5f9" "2–5 days"
label "effort/L"  "bfd4f2" "1–2 weeks"
label "effort/XL" "f9d0c4" "More than 2 weeks"

# ── Status (mirrors the comparison document's marks) ──
label "status/shipped"        "0e8a16" "Implemented and verified — closed"
label "status/partial"        "fef2c0" "A reduced version exists"
label "status/spec-only"      "c2e0c6" "docs/features spec exists, no code"
label "status/blocked"        "e99695" "Has unresolved blockers"
label "status/blocked-others" "d876e3" "Other issues are blocked on this one"

# ── Meta ──
label "parity/kandev"    "006b75" "Needed to match kandev's capability surface"
label "differentiator"   "fbca04" "GateControl-only; kandev has no equivalent"
label "good first issue" "7057ff" "Well-scoped, low prerequisite knowledge"

echo "Labels applied."
