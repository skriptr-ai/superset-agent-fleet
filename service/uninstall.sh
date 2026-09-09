#!/usr/bin/env bash
# Stop the login service and remove it. The repo and the state file are left alone.
set -euo pipefail
label="ai.skriptr.superset-agent-fleet"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$label.plist"

# Only our own symlink: a wrapper someone installed by hand, or from the plugin, is theirs.
wrapper="$HOME/.claude/skills/superset/bin/superset-send"
[[ -L "$wrapper" ]] && rm -f "$wrapper"

echo "Superset Agent Fleet login service removed."
