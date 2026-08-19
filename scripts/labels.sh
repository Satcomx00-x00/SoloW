#!/usr/bin/env bash
# Apply the GateControl issue-label taxonomy from `.github/labels.json`.
#
# This is the local equivalent of the "Sync issue labels" workflow — same manifest,
# same behaviour — for when you would rather not wait for CI. Idempotent: creates
# what is missing, updates the rest, never deletes.
#
# Requires: gh (authenticated), jq
# Usage:    scripts/labels.sh [owner/repo]      # defaults to the current repo

set -euo pipefail

MANIFEST="$(dirname "$0")/../.github/labels.json"
[ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST" >&2; exit 1; }

GH_ARGS=()
[ $# -gt 0 ] && GH_ARGS=(--repo "$1")

existing="$(gh label list "${GH_ARGS[@]}" --limit 200 --json name --jq '.[].name')"
created=0
updated=0

while IFS=$'\t' read -r name color description; do
  if printf '%s\n' "$existing" | grep -qxF "$name"; then
    gh label edit "$name" "${GH_ARGS[@]}" --color "$color" --description "$description"
    printf 'updated  %-24s #%s\n' "$name" "$color"
    updated=$((updated + 1))
  else
    gh label create "$name" "${GH_ARGS[@]}" --color "$color" --description "$description"
    printf 'created  %-24s #%s\n' "$name" "$color"
    created=$((created + 1))
  fi
done < <(jq -r '.[] | [.name, .color, .description] | @tsv' "$MANIFEST")

echo "Labels synced — $created created, $updated updated."
