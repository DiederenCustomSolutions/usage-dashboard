#!/usr/bin/env bash
# Brings the measuring Chromes back after the agents-pc starts or Chrome is updated (no timer:
# systemd starts this once on either event, see install.sh). Telegram only when it had to repair
# after a start, or when repairing failed.
# Which Chromes exist comes from the profile list (profielen.mjs), so a new user is covered at once.
#   boot:   check that all of them run and really measure; restart them only when they do not.
#   update: wait for apt, then restart them: a running Chrome relaunches itself after an update,
#           outside its service and without the extension (4-11-2026).
set -uo pipefail
REASON="${1:-boot}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
START_S="${HERSTEL_START_S:-120}"   # let the Chromes and the network settle first
RONDES="${HERSTEL_RONDES:-14}"      # 14 x 30 s: longer than the 5 min after which the service asks
PAUZE_S="${HERSTEL_PAUZE_S:-30}"  # HERSTEL_STIL=1 for a test: no Telegram

mkdir -p "$HOME/.cache"
profs() { node "$HERE/profielen.mjs" names "$1"; }   # unit | script
exec 9>"$HOME/.cache/usage-chrome-herstel.lock"
flock -w 1500 9 || { echo "another repair is still running"; exit 0; }

notify() { [ -z "${HERSTEL_STIL:-}" ] || { echo "telegram: $2"; return; }; hermes --profile github-it send --to telegram:8673203946 --subject "$1" "$2" >/dev/null 2>&1 || echo "telegram failed"; }

chromes_up() {
    # A Chrome that relaunched itself left its service, so the unit profiles must be in theirs.
    local p
    for p in $(profs unit); do systemctl --user is-active --quiet "chrome-usage@$p.service" || return 1; done
    for p in $(profs script); do
        pgrep -f -- "--user-data-dir=$HOME/.config/chrome-usage-$p( |\$)" >/dev/null || return 1
    done
}

measures_since() {
    local i
    for ((i = 0; i < RONDES; i++)); do
        chromes_up && node "$HERE/herstel-check.mjs" "$1" && return 0
        sleep "$PAUZE_S"
    done
    return 1
}

restart_chromes() {
    echo "restarting the measuring Chromes"
    local p i units=() svcs=() alt=""
    for p in $(profs unit); do units+=("$p"); svcs+=("chrome-usage@$p.service"); alt="${alt:+$alt|}$p"; done
    # systemctl alone does not reach a Chrome that relaunched itself outside its service.
    [ ${#svcs[@]} = 0 ] || systemctl --user stop "${svcs[@]}"
    for p in "${units[@]}"; do pkill -f -- "^/opt/google/chrome/chrome .*--user-data-dir=$HOME/.config/chrome-usage-$p( |\$)"; done
    for ((i = 0; i < 15; i++)); do
        [ -n "$alt" ] || break
        pgrep -f -- "^/opt/google/chrome/chrome .*--user-data-dir=$HOME/.config/chrome-usage-($alt)( |\$)" >/dev/null || break
        sleep 1
    done
    [ ${#svcs[@]} = 0 ] || systemctl --user start "${svcs[@]}"
    # Own scope: a finished service would kill the script-started Chromes along with its cgroup.
    # Retry: right after starting the units the user bus once refused a scope (10-11-2026).
    for p in $(profs script); do
        for ((i = 0; i < 3; i++)); do
            systemd-run --user --scope --quiet --collect python3 "$HERE/usage-chrome-script.py" "$p" restart && break
            sleep 5
        done
    done
}

# A public login link (Funnel) must never outlive a restart of the agents-pc.
command -v tailscale >/dev/null && tailscale funnel --https=8443 off >/dev/null 2>&1 || true

if [ "$REASON" = update ]; then
    for ((i = 0; i < 120; i++)); do pgrep -x 'apt|apt-get|dpkg' >/dev/null || break; sleep 5; done
    sleep "$START_S"
else
    sleep "$START_S"
    measures_since "$(($(date +%s) * 1000))" && { echo "measuring works"; exit 0; }
fi

restart_chromes
if measures_since "$(($(date +%s) * 1000))"; then
    echo "measuring works after the restart"
    [ "$REASON" = update ] || notify "Usage Dashboard hersteld" "Na de herstart van de agents-pc mat het dashboard niet. Ik heb de meet-Chromes herstart; het meet weer."
    exit 0
fi
echo "measuring still does not work"
notify "Usage Dashboard meet niet" "Na $REASON op de agents-pc krijg ik de meet-Chromes niet aan het meten, ook niet na een herstart. Kijk naar agent-api/README.md."
exit 1
