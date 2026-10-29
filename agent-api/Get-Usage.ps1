<#
.SYNOPSIS
    Returns the current usage per subscription (or the advised account) as an object.
.EXAMPLE
    (Get-Usage).accounts | Format-Table id, naam, @{n='5u';e={$_.vijf_uur.gebruikt_pct}}, @{n='week';e={$_.week.gebruikt_pct}}, betrouwbaar
.EXAMPLE
    (Get-Usage -Advies zwaar).account
#>
[CmdletBinding()]
param(
    [ValidateSet("zwaar", "klein")][string]$Advies,
    [Nullable[bool]]$Overdag,
    [string]$Url = $(if ($env:USAGE_API_URL) { $env:USAGE_API_URL } else { "http://127.0.0.1:8787" }),
    [string]$TokenFile = $(if ($env:USAGE_API_TOKEN_FILE) { $env:USAGE_API_TOKEN_FILE } else { Join-Path $HOME ".config/usage-api/token" })
)
$token = (Get-Content -Raw -LiteralPath $TokenFile).Trim()
$path = "/v1/usage"
if ($Advies) {
    $path = "/v1/advies?soort=$Advies"
    if ($null -ne $Overdag) { $path += "&overdag=$("$Overdag".ToLower())" }
}
Invoke-RestMethod -Uri ($Url.TrimEnd("/") + $path) -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5
