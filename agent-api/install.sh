#!/usr/bin/env bash
# Installs the usage read service on the agents-pc as a systemd user service.
# Safe to run again: existing config and token are kept; the sync key is re-read.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONF="$HOME/.config/usage-api"
mkdir -p "$CONF"; chmod 700 "$CONF"

[ -f "$CONF/config.json" ] || cp "$HERE/config.example.json" "$CONF/config.json"
if [ ! -f "$CONF/token" ]; then
    (umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$CONF/token")
fi
chmod 600 "$CONF/token"
node "$HERE/read-sync-key.mjs" "${CDP_PORT:-9233}" "$CONF/sync.json"

mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/usage-api.service" <<EOF
[Unit]
Description=Usage read service for AI agents (usage dashboard)

[Service]
ExecStart=$(command -v node) $HERE/server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now usage-api.service
systemctl --user restart usage-api.service
sleep 1
systemctl --user --no-pager --lines=3 status usage-api.service | head -5
