#!/usr/bin/env bash
# Stop the macOS login service and remove its definition. Keep the repo and saved state.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo 'uninstall: use service/uninstall-linux.sh on Linux' >&2; exit 1; }
label="ai.skriptr.superset-agent-fleet"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$label.plist"

# Remove only links to this checkout installed by earlier versions of install.sh.
for wrapper in "$HOME/.local/bin/superset-send" "$HOME/.claude/skills/superset/bin/superset-send"; do
  if [[ -L "$wrapper" && "$(readlink "$wrapper")" == "$here/bin/superset-send" ]]; then
    rm -f "$wrapper"
  fi
done
echo 'Superset Agent Fleet login service removed.'
