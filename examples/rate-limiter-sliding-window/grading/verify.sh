#!/usr/bin/env bash
set -euo pipefail

# evalkit deterministic grading entrypoint
# Must exit 0 on pass and non-zero on failure.
# Expected environment:
#   WORKSPACE_DIR - repo working directory (defaults to current working directory)
#   GRADING_DIR   - read-only grading directory containing tests/ and verify.sh

WORKSPACE_DIR="${WORKSPACE_DIR:-$(pwd)}"
GRADING_DIR="${GRADING_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

cd "$WORKSPACE_DIR"

# Copy hidden fail-to-pass tests into workspace at grading time
if [ -d "$GRADING_DIR/tests" ]; then
  cp -R "$GRADING_DIR/tests/." "$WORKSPACE_DIR/"
fi

# Run deterministic verification suite
npm test
