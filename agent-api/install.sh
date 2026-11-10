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
# Login links (v0.34.0): add the profile map to an existing config, keep everything else.
node -e '
const fs=require("fs"),[,c,e]=process.argv,cfg=JSON.parse(fs.readFileSync(c,"utf8")),ex=JSON.parse(fs.readFileSync(e,"utf8"));
if(!cfg.inlog_profielen){cfg.inlog_profielen=ex.inlog_profielen;cfg.inlog_min=ex.inlog_min;fs.writeFileSync(c,JSON.stringify(cfg,null,2)+"\n")}
' "$CONF/config.json" "$HERE/config.example.json"
# The login link script runs from the repo; keep the old ~/bin name as a link.
chmod +x "$HERE/usage-inloglink"
mkdir -p "$HOME/bin"; ln -sf "$HERE/usage-inloglink" "$HOME/bin/usage-inloglink"
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

# Repair of the measuring Chromes: once per graphical start and once per Chrome update.
cat > "$HOME/.config/systemd/user/usage-herstel@.service" <<EOF
[Unit]
Description=Measuring Chromes back after %i
# Without this the target waits for this oneshot, which waits for the Chromes, which wait for
# the target: no Chrome started after a boot (10-11-2026).
After=graphical-session.target

[Service]
Type=oneshot
ExecStart=$HERE/herstel-meetchromes.sh %i
TimeoutStartSec=45min

[Install]
WantedBy=graphical-session.target
EOF
cat > "$HOME/.config/systemd/user/usage-herstel-chrome.path" <<EOF
[Unit]
Description=Watch for a Chrome update

[Path]
PathChanged=/opt/google/chrome/chrome
Unit=usage-herstel@update.service

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable usage-herstel@boot.service
systemctl --user enable --now usage-herstel-chrome.path
systemctl --user enable --now usage-api.service
systemctl --user restart usage-api.service
sleep 1
systemctl --user --no-pager --lines=3 status usage-api.service | head -5
