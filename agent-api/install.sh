#!/usr/bin/env bash
# Installs the usage read service on the agents-pc as a systemd user service.
# Safe to run again: existing config and token are kept; the sync key is re-read.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
CONF="$HOME/.config/usage-api"
mkdir -p "$CONF"; chmod 700 "$CONF"

[ -f "$CONF/config.json" ] || cp "$HERE/config.example.json" "$CONF/config.json"
if [ ! -f "$CONF/token" ]; then
    (umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$CONF/token")
fi
chmod 600 "$CONF/token"
# Login links (v0.34.0): the login time. v0.35.0: the profile map is gone from the config, the one
# list of measuring profiles is profielen.json (names, pids, ports); an existing list is kept.
node -e '
const fs=require("fs"),[,c,e]=process.argv,cfg=JSON.parse(fs.readFileSync(c,"utf8")),ex=JSON.parse(fs.readFileSync(e,"utf8"));
if(cfg.inlog_profielen||cfg.inlog_min==null){delete cfg.inlog_profielen;cfg.inlog_min??=ex.inlog_min;fs.writeFileSync(c,JSON.stringify(cfg,null,2)+"\n")}
' "$CONF/config.json" "$HERE/config.example.json"
[ -f "$CONF/profielen.json" ] || (umask 077; cp "$HERE/profielen.example.json" "$CONF/profielen.json")
chmod 600 "$CONF/profielen.json"
node "$HERE/profielen.mjs" sync-env

# The scripts run from the repo; the ~/bin names stay as links. A script that was there before
# (not yet a link) is kept once as .bak-<date>.
mkdir -p "$HOME/bin"
chmod +x "$HERE/usage-inloglink" "$HERE/usage-gebruiker-toevoegen" "$HERE/usage-chrome-autoupdate.sh" "$HERE/usage-chrome-script.py"
link() {   # link <target> <name in ~/bin>
    [ -e "$HOME/bin/$2" ] && [ ! -L "$HOME/bin/$2" ] && mv "$HOME/bin/$2" "$HOME/bin/$2.bak-$(date +%Y%m%d)"
    ln -sf "$1" "$HOME/bin/$2"
}
link "$HERE/usage-inloglink" usage-inloglink
link "$HERE/usage-gebruiker-toevoegen" usage-gebruiker-toevoegen
link "$HERE/usage-chrome-autoupdate.sh" usage-chrome-autoupdate.sh
rm -f "$HOME/bin/usage-inloglink.mjs"   # the .mjs now lives next to the script, in the repo
# The old Kevin scripts become shims around the one script (same names, same arguments).
for p in $(node "$HERE/profielen.mjs" names script); do
    f="$HOME/bin/start-usage-chrome-${p}.sh"
    [ -e "$f" ] && ! grep -q usage-chrome-script.py "$f" && mv "$f" "$f.bak-$(date +%Y%m%d)"
    printf '#!/bin/bash\nexec python3 "%s/usage-chrome-script.py" %s "$@"\n' "$HERE" "$p" > "$f"
    chmod +x "$f"
done
FIRST=$(node "$HERE/profielen.mjs" names | head -1)
node "$HERE/read-sync-key.mjs" "${CDP_PORT:-$(node "$HERE/profielen.mjs" get "$FIRST" debugpoort)}" "$CONF/sync.json"

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
# The measuring Chrome of a unit profile. ALWAYS --password-store=basic (without it the keyring stays
# locked after the automatic login and every account loses its login, 10-11-2026). The debug port comes
# from the profile list through chrome-env/<naam>.env (written by profielen.mjs sync-env), so the
# debugpoort.conf drop-ins are no longer needed (moved aside). Running Chromes are not touched here.
cat > "$HOME/.config/systemd/user/chrome-usage@.service" <<EOF
[Unit]
Description=Usage Dashboard Chrome for %i (extension from $REPO)
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
EnvironmentFile=%h/.config/usage-api/chrome-env/%i.env
ExecStartPre=-%h/bin/chrome-usage-prestart.sh %h/.config/chrome-usage-%i
ExecStart=/opt/google/chrome/chrome --ozone-platform=x11 --password-store=basic --remote-debugging-address=127.0.0.1 --remote-debugging-port=\${DEBUG_PORT} --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --user-data-dir=%h/.config/chrome-usage-%i --no-first-run --no-default-browser-check --disable-features=DisableLoadExtensionCommandLineSwitch --load-extension=$REPO https://claude.ai/robots.txt https://chatgpt.com/robots.txt
Restart=on-failure
RestartSec=15

[Install]
WantedBy=graphical-session.target
EOF
for d in "$HOME"/.config/systemd/user/chrome-usage@*.service.d; do
    [ -d "$d" ] || continue
    mkdir -p "$HOME/.cache/usage-backup-drop-ins"
    mv "$d" "$HOME/.cache/usage-backup-drop-ins/$(basename "$d").$(date +%Y%m%d%H%M%S)"
done
systemctl --user daemon-reload
systemctl --user enable usage-herstel@boot.service
systemctl --user enable --now usage-herstel-chrome.path
systemctl --user enable --now usage-api.service
systemctl --user restart usage-api.service
sleep 1
systemctl --user --no-pager --lines=3 status usage-api.service | head -5
