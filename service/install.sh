#!/usr/bin/env bash
# Optional macOS login service. Uses this repo's .env and your existing Superset login.
# Internal cloud users may add --doppler CONFIG [--project PROJECT].
set -euo pipefail

[[ "$(uname -s)" == Darwin ]] || { echo 'install: use service/install-linux.sh on Linux' >&2; exit 1; }
doppler_config=""
doppler_project="agent-fleet"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --doppler|--project)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "install: $1 needs a value" >&2; exit 1; }
      if [[ "$1" == --doppler ]]; then doppler_config="$2"; else doppler_project="$2"; fi
      shift 2 ;;
    *) echo "install: unknown argument $1" >&2; exit 1 ;;
  esac
done

label="ai.skriptr.superset-agent-fleet"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
plist="$HOME/Library/LaunchAgents/$label.plist"
bun="$(command -v bun || true)"
doppler=""
[[ -n "$bun" ]] || { echo 'install: bun is not on PATH' >&2; exit 1; }
superset="$("$bun" service/configure.js cli)"
[[ -n "$superset" ]] || { echo 'install: the Superset CLI is not on PATH; set SUPERSET_CLI if needed' >&2; exit 1; }
if [[ -n "$doppler_config" ]]; then
  doppler="$(command -v doppler || true)"
  [[ -n "$doppler" ]] || { echo 'install: the Doppler CLI is not on PATH' >&2; exit 1; }
fi
run_helper() {
  if [[ -n "$doppler_config" ]]; then
    "$doppler" run -p "$doppler_project" -c "$doppler_config" -- "$bun" service/configure.js "$@"
  else
    "$bun" service/configure.js "$@"
  fi
}
url="$(run_helper url)"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
"$bun" --no-env-file service/configure.js render darwin "$plist" "$bun" "$superset" "$doppler" "$doppler_config" "$doppler_project"
chmod 600 "$plist"
domain="gui/$(id -u)"
launchctl bootout "$domain/$label" 2>/dev/null || true
# Only launchd's own job was stopped. Never kill a process merely because it owns the port.
probe=0
run_helper probe || probe=$?
if [[ "$probe" != 1 ]]; then
  echo "install: $url is occupied or could not be checked. Stop the existing server yourself, or change AGENT_FLEET_PORT in .env and rerun." >&2
  exit 1
fi
launchctl bootstrap "$domain" "$plist"
for _ in $(seq 1 60); do
  if run_helper probe; then
    echo "Superset Agent Fleet is running as a login service: $url"
    echo "  log: $HOME/Library/Logs/superset-agent-fleet.log"
    echo "  stop: $here/service/uninstall.sh"
    exit 0
  fi
  sleep 0.25
done
echo "install: the job loaded but Agent Fleet did not answer at $url; see $HOME/Library/Logs/superset-agent-fleet.log" >&2
exit 1
