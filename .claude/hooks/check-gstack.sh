#!/bin/bash
# Lazy install of gstack.
#
# - Skills that are NOT part of gstack pass through transparently (no install).
# - Skills that ARE part of gstack trigger an install on first use, then pass.
# - Subsequent invocations after install pass through with no overhead.
#
# This hook runs only for the Skill tool (see .claude/settings.json matcher).

set -u

GSTACK_SKILLS="qa ship review investigate browse"
GSTACK_DIR="$HOME/.claude/skills/gstack"

INPUT=$(cat)

SKILL_NAME=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('skill', ''))
except Exception:
    pass
" 2>/dev/null)

is_gstack_skill=0
for s in $GSTACK_SKILLS; do
  if [ "$SKILL_NAME" = "$s" ]; then
    is_gstack_skill=1
    break
  fi
done

if [ "$is_gstack_skill" -eq 0 ]; then
  echo '{}'
  exit 0
fi

if [ -d "$GSTACK_DIR/bin" ]; then
  echo '{}'
  exit 0
fi

echo "[gstack] Installing gstack on first use (one-time, ~20s)..." >&2

if git clone --depth 1 --quiet https://github.com/garrytan/gstack.git "$GSTACK_DIR" >&2 \
   && (cd "$GSTACK_DIR" && ./setup --team >&2); then
  echo "[gstack] Install complete." >&2
  echo '{}'
  exit 0
fi

cat >&2 <<'MSG'
BLOCKED: gstack auto-install failed.

Install manually:
  git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
  cd ~/.claude/skills/gstack && ./setup --team
MSG
echo '{"permissionDecision":"deny","message":"gstack auto-install failed. See stderr for manual install steps."}'
exit 0
