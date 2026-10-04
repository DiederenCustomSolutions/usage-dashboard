# release.ps1
# Publishes a release that is ready locally (bump-version.ps1 + CHANGELOG + commit + tag) and
# updates the measuring Chromes on agents-pc right away. The release is the trigger: nothing
# polls GitHub on a timer anywhere (Rob, 04-10-2026: work only starts when something triggers it).
#
# Usage (from this folder):
#   .\release.ps1
#
# What happens:
#   1. Checks: no uncommitted changes, and tag v<version from manifest.json> sits on the last commit.
#   2. git push of main + every v* tag that GitHub does not have yet.
#      -> GitHub Pages publishes the website/phone version, the Action creates the GitHub Release.
#   3. agents-pc: runs ~/bin/usage-chrome-autoupdate.sh over ssh (git pull in ~/usage-dashboard-proef
#      + restart of the four measuring Chromes) and shows its result.
#   PCs with the extension: the version label in the dashboard turns orange -> one click updates.

param(
    [string]$AgentsHost = "agents-controller"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Fail($message) {
    Write-Host "Gestopt: $message" -ForegroundColor Red
    exit 1
}

# --- 1. Checks ---
$version = (Get-Content (Join-Path $PSScriptRoot "manifest.json") -Raw | ConvertFrom-Json).version
if (git status --porcelain --untracked-files=no) {
    Fail "er staan nog niet-gecommitte wijzigingen. Eerst committen (en taggen)."
}
$head = (git rev-parse HEAD).Trim()
$tagCommit = (git rev-list -n 1 "v$version" 2>$null)
if (-not $tagCommit -or $tagCommit.Trim() -ne $head) {
    Fail "tag v$version ontbreekt of staat niet op de laatste commit (git tag v$version)."
}

$remoteTags = git ls-remote --tags origin | ForEach-Object { ($_ -split "refs/tags/")[1] -replace '\^\{\}$', '' } | Sort-Object -Unique
$newTags = @(git tag --list "v*" | Where-Object { $remoteTags -notcontains $_ })

Write-Host "Release v$version" -ForegroundColor Cyan
Write-Host "  nieuwe tags: $(if ($newTags.Count) { $newTags -join ', ' } else { '(geen)' })"

# --- 2. Push ---
git push origin main
if ($LASTEXITCODE -ne 0) { Fail "git push van main mislukt." }
if ($newTags.Count) {
    git push origin @newTags
    if ($LASTEXITCODE -ne 0) { Fail "git push van de tags mislukt." }
}
Write-Host "  [OK] GitHub bijgewerkt (website volgt binnen enkele minuten via GitHub Pages)" -ForegroundColor Green

# --- 3. agents-pc ---
Write-Host "agents-pc bijwerken..." -ForegroundColor Cyan
# Over ssh on purpose (not as a systemd service): see the comment in usage-chrome-autoupdate.sh.
ssh $AgentsHost '~/bin/usage-chrome-autoupdate.sh'
if ($LASTEXITCODE -ne 0) {
    Write-Host "  agents-pc is niet bijgewerkt (zie hierboven). Later opnieuw: ssh $AgentsHost ~/bin/usage-chrome-autoupdate.sh" -ForegroundColor Yellow
    exit 1
}
Write-Host "  [OK] agents-pc bijgewerkt" -ForegroundColor Green
Write-Host ""
Write-Host "Klaar. Op een pc met de extensie: open het dashboard en klik op het oranje versielabel." -ForegroundColor Green
