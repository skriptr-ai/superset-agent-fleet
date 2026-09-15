#!/usr/bin/env bash
# Optional background launcher. For foreground use, run bun start.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
log="${TMPDIR:-/tmp}/agent-fleet.log"
command -v bun >/dev/null 2>&1 || { echo 'agent-fleet: needs bun on PATH' >&2; exit 1; }
url="$(bun service/configure.js url)"
probe=0
bun service/configure.js probe || probe=$?
if [[ "$probe" == 0 ]]; then
  echo "Superset Agent Fleet already running: $url"
  exit 0
elif [[ "$probe" != 1 ]]; then
  echo "agent-fleet: $url is occupied or could not be checked. Change AGENT_FLEET_PORT in .env, or stop the existing process yourself." >&2
  exit 1
fi
nohup bun server.js >"$log" 2>&1 &
disown || true
for _ in $(seq 1 40); do
  if bun service/configure.js probe; then
    echo "Superset Agent Fleet: $url, log: $log"
    exit 0
  fi
  sleep 0.25
done
echo "agent-fleet: did not come up at $url; see $log" >&2
exit 1
