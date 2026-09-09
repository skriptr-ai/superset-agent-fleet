#!/usr/bin/env bash
# Start Superset Agent Fleet in the background and print its URL.
#
# Safe to run unconditionally at the top of an orchestration run: the server itself detects an
# instance already holding the port and exits 0 without starting a second one, so this never
# needs guarding with a "is it up?" check.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
port="${AGENT_FLEET_PORT:-4400}"
log="${TMPDIR:-/tmp}/agent-fleet.log"

if ! command -v bun >/dev/null 2>&1; then
  echo "agent-fleet: needs bun on PATH" >&2
  exit 1
fi

if curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
  echo "Superset Agent Fleet already running — http://localhost:${port}"
  exit 0
fi

# Detached with its own stdio: the orchestrator's terminal must not hold the server open, and
# the server must not write into the orchestrator's transcript once it has been handed off.
nohup bun "${here}/server.js" >"${log}" 2>&1 &
disown || true

for _ in $(seq 1 40); do
  if curl -fsS --max-time 1 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    echo "Superset Agent Fleet — http://localhost:${port}  (log: ${log})"
    exit 0
  fi
  sleep 0.25
done

echo "agent-fleet: did not come up on ${port}; see ${log}" >&2
exit 1
