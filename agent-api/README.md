# Usage-leesservice voor agents

Agents vragen hier het actuele verbruik per abonnement op: dezelfde cijfers als het dashboard. Welk account een agent neemt, bepalen de agents zelf (agents-infra); dat hoort niet in deze repo. De service draait op de agents-pc en leest dezelfde gegevens als het dashboard. Je kunt er alleen mee lezen.

## Aanroepen

Het token staat in `~/.config/usage-api/token` en hoort in de header. Zet het nooit in een URL of een log.

Op de agents-pc is het adres `http://127.0.0.1:8787`. Via het tailnet is het `http://100.70.217.45:8787`; de omgevingsvariabele `USAGE_API_URL` op Robs pc wijst daarheen. Andere adressen krijgen 403.

**curl**
```bash
curl -s -H "Authorization: Bearer $(cat ~/.config/usage-api/token)" http://127.0.0.1:8787/v1/usage
```

**PowerShell**
```powershell
$h = @{ Authorization = "Bearer $((Get-Content -Raw ~/.config/usage-api/token).Trim())" }
Invoke-RestMethod http://127.0.0.1:8787/v1/usage -Headers $h
# of met de helper:
(Get-Usage).accounts | Format-Table id, @{n='5u';e={$_.vijf_uur.gebruikt_pct}}, @{n='week';e={$_.week.gebruikt_pct}}
```

**Python**
```python
import json, pathlib, urllib.request
token = (pathlib.Path.home() / ".config/usage-api/token").read_text().strip()
req = urllib.request.Request("http://127.0.0.1:8787/v1/usage", headers={"Authorization": f"Bearer {token}"})
print(json.load(urllib.request.urlopen(req, timeout=5)))
```

## Endpoints

- **`GET /v1/usage`** geeft `gemeten_op` en `accounts[]` terug. Elk account heeft:
  - `id`, `naam`, `eigenaar`, `dienst` en `abonnement`;
  - `vijf_uur`: is `null` als het account geen 5-uurslimiet heeft;
  - `week`;
  - `bron`, `laatst_gezien` en `betrouwbaar`. `betrouwbaar` is `false` als de meting ouder is dan 15 minuten of als de database niet bereikbaar was. Je krijgt dan de laatst bekende waarden met een `fout`-tekst erbij.

## Werking

Elke aanvraag krijgt binnen 2 seconden antwoord uit de cache. De database wordt hooguit eens per 20 seconden gelezen.

Is de nieuwste meting ouder dan 5 minuten, dan vraagt de service de meet-Chromes om te verversen. Dat is hetzelfde als de verversknop op het dashboard en gebeurt hooguit eens per 2 minuten. De service heeft geen timer: alleen een aanvraag zet iets in gang.

## Installeren en testen

Installeren op de agents-pc:

```bash
bash ~/usage-dashboard-proef/agent-api/install.sh
```

Het script maakt de config en het token aan, haalt de sleutel uit de meet-Chrome en zet de user-service `usage-api` aan.

Testen:

```bash
node --test agent-api/test/agent-api.test.mjs
```
