#!/usr/bin/env bash
# Stop and remove the optional Linux user service. Keep the repo, credentials, and saved state.
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'uninstall: use service/uninstall.sh on macOS' >&2; exit 1; }
unit="superset-agent-fleet"
systemctl --user disable --now "$unit"
rm -f "$HOME/.config/systemd/user/$unit.service"
systemctl --user daemon-reload
echo 'Superset Agent Fleet user service removed.'
