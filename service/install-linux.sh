#!/usr/bin/env bash
# Install Superset Agent Fleet as a systemd user service on a Linux host: it starts at boot
# (the user must linger), is restarted if it ever exits, and reports this machine to the
# public view.
#
#   ./service/install-linux.sh <doppler config>        e.g. prd_dev_vm
#
# The server runs under `doppler run`, which is where AGENT_FLEET_PUSH_URL, _PUSH_KEY and
# _SCOPE come from. Doppler needs a token: a personal login on the machine works, and so does
# a service token for just this config written to ~/.config/superset-agent-fleet/doppler.env
# as `DOPPLER_TOKEN=…` (mode 600). The second is what a machine nobody logs in to should use.
#
# Re-running this is safe: it replaces the unit.
set -euo pipefail

config="${1:-}"
[[ -n "$config" ]] || { echo "usage: $0 <doppler config>" >&2; exit 1; }

unit="superset-agent-fleet"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bun="$(command -v bun || ls "$HOME/.bun/bin/bun" 2>/dev/null || true)"
doppler="$(command -v doppler || true)"
superset="$(command -v superset || ls "$HOME/superset/bin/superset" 2>/dev/null || true)"

[[ -n "$bun" ]] || { echo "install: bun is not on PATH or in ~/.bun/bin" >&2; exit 1; }
[[ -n "$doppler" ]] || { echo "install: the doppler CLI is not on PATH" >&2; exit 1; }
[[ -n "$superset" ]] || { echo "install: the superset CLI is not on PATH or in ~/superset/bin" >&2; exit 1; }

envdir="$HOME/.config/superset-agent-fleet"
mkdir -p "$envdir" "$HOME/.config/systemd/user"
[[ -f "$envdir/doppler.env" ]] || : > "$envdir/doppler.env"
chmod 600 "$envdir/doppler.env"

# The job's PATH: wherever the tools were found now, plus the usual places.
path="$(dirname "$bun"):$(dirname "$superset"):$HOME/.superset/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

cat > "$HOME/.config/systemd/user/$unit.service" <<EOF
[Unit]
Description=Superset Agent Fleet (this host, reporting to the cloud)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$here
Environment=PATH=$path
Environment=HOME=$HOME
EnvironmentFile=$envdir/doppler.env
ExecStart=$doppler run -p agent-fleet -c $config -- $bun server.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$unit" >/dev/null
systemctl --user restart "$unit"

for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 http://127.0.0.1:4400/api/health >/dev/null 2>&1; then
    echo "Superset Agent Fleet is running as a user service — http://localhost:4400 on $(hostname)"
    echo "  status: systemctl --user status $unit"
    echo "  log:    journalctl --user -u $unit -f"
    exit 0
  fi
  sleep 0.5
done
echo "install: the unit started but nothing answered on :4400 — journalctl --user -u $unit" >&2
exit 1
