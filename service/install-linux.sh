#!/usr/bin/env bash
# Optional systemd user service. No Doppler required for local use.
# Internal use: --doppler CONFIG [--project PROJECT], or the original positional CONFIG.
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'install: use service/install.sh on macOS' >&2; exit 1; }
config=""
project="agent-fleet"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --doppler|--project)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "install: $1 needs a value" >&2; exit 1; }
      if [[ "$1" == --doppler ]]; then config="$2"; else project="$2"; fi
      shift 2 ;;
    --*) echo "install: unknown argument $1" >&2; exit 1 ;;
    *) [[ -z "$config" ]] || { echo 'install: only one Doppler config is allowed' >&2; exit 1; }; config="$1"; shift ;;
  esac
done
unit="superset-agent-fleet"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
bun="$(command -v bun || true)"
doppler=""
[[ -n "$bun" ]] || { echo 'install: bun is not on PATH' >&2; exit 1; }
superset="$("$bun" service/configure.js cli)"
[[ -n "$superset" ]] || { echo 'install: the Superset CLI is not on PATH; set SUPERSET_CLI if needed' >&2; exit 1; }
command -v systemctl >/dev/null || { echo 'install: systemd is required; use bun start instead' >&2; exit 1; }
if [[ -n "$config" ]]; then
  doppler="$(command -v doppler || true)"
  [[ -n "$doppler" ]] || { echo 'install: the Doppler CLI is not on PATH' >&2; exit 1; }
fi
run_helper() {
  if [[ -n "$config" ]]; then
    "$doppler" run -p "$project" -c "$config" -- "$bun" service/configure.js "$@"
  else
    "$bun" service/configure.js "$@"
  fi
}
url="$(run_helper url)"
mkdir -p "$HOME/.config/systemd/user"
"$bun" --no-env-file service/configure.js render linux "$HOME/.config/systemd/user/$unit.service" "$bun" "$superset" "$doppler" "$config" "$project"
systemctl --user stop "$unit" 2>/dev/null || true
probe=0
run_helper probe || probe=$?
if [[ "$probe" != 1 ]]; then
  echo "install: $url is occupied or could not be checked. Stop the existing server yourself, or change AGENT_FLEET_PORT in .env and rerun." >&2
  exit 1
fi
systemctl --user daemon-reload
systemctl --user enable "$unit" >/dev/null
systemctl --user start "$unit"
for _ in $(seq 1 60); do
  if run_helper probe; then
    echo "Superset Agent Fleet is running as a user service: $url"
    echo "  status: systemctl --user status $unit"
    echo "  log: journalctl --user -u $unit -f"
    exit 0
  fi
  sleep 0.5
done
echo "install: Agent Fleet did not answer at $url; run journalctl --user -u $unit" >&2
exit 1
