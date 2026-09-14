#!/usr/bin/env bash
# Install Superset Agent Fleet as a login service: it starts when you log in to the Mac, is
# restarted if it ever exits, and is simply always at http://localhost:4400.
#
# With a Doppler config the server runs under `doppler run`, which is where the cloud's
# address and this machine's push key come from:
#
#   ./service/install.sh --doppler prd_macbook
#
# Without one it runs as before, reading this machine for its own page and reporting nowhere.
#
# Re-running this is safe: it replaces the job. `uninstall.sh` removes it.
set -euo pipefail

doppler_config=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --doppler) doppler_config="${2:-}"; shift 2 ;;
    *) echo "install: unknown argument $1" >&2; exit 1 ;;
  esac
done

label="ai.skriptr.superset-agent-fleet"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plist="$HOME/Library/LaunchAgents/$label.plist"
bun="$(command -v bun || true)"
superset="$(command -v superset || true)"

[[ -n "$bun" ]] || { echo "install: bun is not on PATH" >&2; exit 1; }
[[ -n "$superset" ]] || { echo "install: the superset CLI is not on PATH" >&2; exit 1; }

# launchd runs the job as you, so your `doppler login` is what it uses — unless DOPPLER_TOKEN
# is set when this runs, in which case that token (a service token for just this config) is
# written into the job instead, and the plist is made readable by you alone.
doppler_args=""
doppler_env=""
if [[ -n "$doppler_config" ]]; then
  doppler="$(command -v doppler || true)"
  [[ -n "$doppler" ]] || { echo "install: the doppler CLI is not on PATH" >&2; exit 1; }
  # One line: launchd does not mind, and sed does.
  [[ -n "${DOPPLER_TOKEN:-}" ]] && doppler_env="<key>DOPPLER_TOKEN</key><string>$DOPPLER_TOKEN</string>"
  doppler_args="<string>$doppler</string><string>run</string><string>-p</string><string>agent-fleet</string><string>-c</string><string>$doppler_config</string><string>--</string>"
fi

# The job's PATH: wherever bun and superset were found now, plus the usual places.
path="$(dirname "$bun"):$(dirname "$superset"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# The wrapper that makes an orchestrator's messages visible whatever harness it runs in (see
# bin/superset-send). Symlinks rather than copies, so `git pull` updates it too.
#
# It goes in two places on purpose. `~/.local/bin` is the real home: nothing else manages it,
# so nothing else can take it away. `~/.claude/skills/superset/bin` is Superset's own, which
# it puts on PATH inside every workspace — the guarantee we actually want — but it sits under
# a `.superset-managed` marker, so an update or a plugin sync may clear it out. Installing to
# both means losing that one costs the PATH guarantee and not the wrapper.
install_wrapper() {
  local dir="$1"
  mkdir -p "$dir" 2>/dev/null || return 1
  ln -sf "$here/bin/superset-send" "$dir/superset-send" 2>/dev/null || return 1
  echo "  $dir/superset-send"
}

echo "Wrapper installed:"
install_wrapper "$HOME/.local/bin" || true
# Only if Superset has made the directory itself; do not create a tree inside someone else's.
[[ -d "$HOME/.claude/skills/superset" ]] && { install_wrapper "$HOME/.claude/skills/superset/bin" || true; }

command -v superset-send >/dev/null || echo "  note: no install directory is on your PATH; add ~/.local/bin to it"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__BUN__|$bun|g" -e "s|__REPO__|$here|g" -e "s|__PATH__|$path|g" -e "s|__HOME__|$HOME|g" \
  -e "s|__DOPPLER__|$doppler_args|g" -e "s|__DOPPLER_ENV__|$doppler_env|g" \
  "$here/service/$label.plist.template" > "$plist"
chmod 600 "$plist"

domain="gui/$(id -u)"
# Replace any previous version of the job, and stop a hand-started server holding the port.
launchctl bootout "$domain/$label" 2>/dev/null || true
if pids="$(lsof -ti tcp:4400 -sTCP:LISTEN 2>/dev/null)" && [[ -n "$pids" ]]; then
  kill $pids || true
  for _ in $(seq 1 40); do lsof -ti tcp:4400 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done
fi
launchctl bootstrap "$domain" "$plist"

for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 http://127.0.0.1:4400/api/health >/dev/null 2>&1; then
    echo "Superset Agent Fleet is running as a login service — http://localhost:4400"
    echo "  job:  launchctl print $domain/$label"
    echo "  log:  $HOME/Library/Logs/superset-agent-fleet.log"
    echo "  stop: $here/service/uninstall.sh"
    exit 0
  fi
  sleep 0.25
done
echo "install: the job loaded but nothing answered on :4400 — see $HOME/Library/Logs/superset-agent-fleet.log" >&2
exit 1
