#!/bin/bash
# Online adapter for the harness-review suite. Builds a throwaway git repo whose working
# tree holds the seeded change, then runs Claude Code on it. The task arrives in
# TRACECHECK_TASK. Prints claude's stream-json on stdout for tracecheck to score.
# Needs: claude on PATH with the harness plugin installed (claude plugin install harness@agent-harness).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT
cp -R "$here/fixture/base/." "$repo/"
cd "$repo"
git init -q && git add -A && git -c user.name=fixture -c user.email=fixture@example.com commit -qm base
cp -R "$here/fixture/change/." "$repo/"
claude -p "$TRACECHECK_TASK" --output-format stream-json --verbose ${REVIEW_ARGS:-}
