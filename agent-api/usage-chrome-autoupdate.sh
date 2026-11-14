#!/bin/bash
# Brings the Usage Dashboard extension of the measuring Chromes on agents-pc up to date.
# Triggered by release.ps1 right after a push (over ssh) — deliberately no timer: Rob wants work
# to start only on a trigger. By hand: ssh agents-controller ~/bin/usage-chrome-autoupdate.sh
# When GitHub main has a new commit: fast-forward ~/usage-dashboard-proef and restart all measuring
# Chromes so they load it. Which Chromes there are comes from the profile list (profielen.mjs):
# a new user is covered at once. Local changes in the folder stop the update.
# All Chromes also start without a Remote Desktop connection (screen 0 x 0): their start strips the
# remembered window position first (~/bin/chrome-usage-prestart.sh, 04-10-2026).
# Run it over ssh, not as a systemd service: a finished service would kill the script-started Chromes
# (they would sit in the service's cgroup).
# (Not to be confused with usage-dashboard-autoupdate.timer: that one updates the old
# self-hosted PWA copy in ~/Repositories/usage-dashboard.)
# The whole body is one function: bash has read all of it before git replaces this file.
set -euo pipefail
REPO="$HOME/usage-dashboard-proef"

main() {
    mkdir -p "$HOME/.cache"
    exec 9>"$HOME/.cache/usage-chrome-autoupdate.lock"
    flock -n 9 || { echo "another update is still running"; return 0; }

    version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/manifest.json" | head -1; }

    cd "$REPO"
    git fetch --quiet origin main
    local before target
    before=$(git rev-parse HEAD)
    target=$(git rev-parse origin/main)
    if [ "$before" = "$target" ]; then
        echo "already up to date: $(git rev-parse --short HEAD) (v$(version))"
        return 0
    fi

    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
        echo "local changes in $REPO, not updating:"; git status --short --untracked-files=no
        return 1
    fi

    git merge --ff-only --quiet origin/main
    echo "updated $(git rev-parse --short "$before") -> $(git rev-parse --short HEAD) (v$(version)); restarting the measuring Chromes"

    local P="$REPO/agent-api/profielen.mjs" failed=0 p
    local units scripts
    units=$(node "$P" names unit); scripts=$(node "$P" names script)
    for p in $units; do systemctl --user restart "chrome-usage@$p.service" || { echo "restart $p failed"; failed=1; }; done
    for p in $scripts; do python3 "$REPO/agent-api/usage-chrome-script.py" "$p" restart >/dev/null || { echo "restart $p failed"; failed=1; }; done
    for p in $units; do echo "$p: $(systemctl --user is-active "chrome-usage@$p.service")"; done
    for p in $scripts; do echo "$p: $(python3 "$REPO/agent-api/usage-chrome-script.py" "$p" status 2>&1 | head -1)"; done
    # The agent read service (agent-api/) runs from the same folder: reload it on new code.
    systemctl --user try-restart usage-api.service 2>/dev/null && echo "usage-api: $(systemctl --user is-active usage-api.service)"
    [ "$failed" = 0 ] && echo "done: v$(version)"
    return "$failed"
}
main "$@"
exit $?
