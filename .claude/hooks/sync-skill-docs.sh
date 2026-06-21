#!/usr/bin/env bash
#
# PostToolUse hook: regenerate the demopilot-demo-scripts skill docs whenever the
# demo-script schema is edited, so the skill never drifts from the source of
# truth. Registered in .claude/settings.json for Edit|Write|MultiEdit.
#
# Claude Code passes the tool event as JSON on stdin; we read tool_input.file_path
# and only act when it's the schema. Always exits 0 (non-blocking).
set -euo pipefail

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# Pull the edited file path out of the hook payload using node (always available;
# the repo requires Node >= 20). Falls back to empty string on any parse issue.
file_path="$(node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const ti = (JSON.parse(raw) || {}).tool_input || {};
      process.stdout.write(String(ti.file_path || ti.path || ""));
    } catch { process.stdout.write(""); }
  });
' 2>/dev/null || true)"

case "$file_path" in
  *packages/core/src/schema.ts|*packages/core/src/jsonSchema.ts)
    echo "[sync-skill-docs] schema changed; regenerating demopilot-demo-scripts skill docs" >&2
    (cd "$root" && pnpm generate:skill-docs >&2) || \
      echo "[sync-skill-docs] generation failed — run 'pnpm generate:skill-docs' manually" >&2
    ;;
  *)
    : # not the schema — nothing to do
    ;;
esac

exit 0
