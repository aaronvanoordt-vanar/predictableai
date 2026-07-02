#!/bin/bash
# PostToolUse hook (Edit|Write): run smoke checks on any edited .html/.js file.
# Catches inline-script SyntaxErrors and unbalanced <div>s before they ship
# (both have taken production down before — see docs/SESSION_AUDIT_2026-07-02.md).
# Exit 2 feeds the failure back to Claude so it fixes the file immediately.

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)

case "$FILE" in
  *.html|*.js) ;;
  *) exit 0 ;;
esac

[ -f "$FILE" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

OUT=$(node "$CLAUDE_PROJECT_DIR/scripts/check.mjs" "$FILE" 2>&1)
if [ $? -ne 0 ]; then
  echo "smoke check failed for $FILE — fix before continuing:" >&2
  echo "$OUT" >&2
  exit 2
fi
exit 0
