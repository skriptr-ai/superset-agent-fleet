#!/usr/bin/env bash
# Stop the login service and remove it. The repo and the state file are left alone.
set -euo pipefail
label="ai.skriptr.superset-agent-fleet"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$label.plist"

# Only our own symlinks: a wrapper someone installed by hand, or by curl, is a real file and
# is theirs to keep.
for wrapper in "$HOME/.local/bin/superset-send" "$HOME/.claude/skills/superset/bin/superset-send"; do
  [[ -L "$wrapper" ]] && rm -f "$wrapper"
done

echo "Superset Agent Fleet login service removed."
