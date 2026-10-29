# Usage-leesservice voor agents

Agents vragen hier het actuele verbruik per abonnement op en welk account ze het best kunnen nemen. De service draait op de agents-pc en leest dezelfde gegevens als het dashboard. Je kunt er alleen mee lezen.

## Aanroepen

Het token staat in `~/.config/usage-api/token` en hoort in de header. Zet het nooit in een URL of een log.

Op de agents-pc is het adres `http://127.0.0.1:8787`. Via het tailnet is het `http://100.70.217.45:8787`; de omgevingsvariabele `USAGE_API_URL` op Robs pc wijst daarheen. Andere adressen krijgen 403.

**curl**
```bash
curl -s -H "Authorization: Bearer $(cat ~/.config/usage-api/token)" http://127.0.0.1:8787/v1/usage
curl -s -H "Authorization: Bearer $(cat ~/.config/usage-api/token)" "http://127.0.0.1:8787/v1/advies?soort=zwaar"
```

**PowerShell**
```powershell
$h = @{ Authorization = "Bearer $((Get-Content -Raw ~/.config/usage-api/token).Trim())" }
Invoke-RestMethod http://127.0.0.1:8787/v1/usage -Headers $h
# of met de helper:
(Get-Usage -Advies klein -Overdag $true).account
```

**Python**
```python
import json, pathlib, urllib.request
token = (pathlib.Path.home() / ".config/usage-api/token").read_text().strip()
req = urllib.request.Request("http://127.0.0.1:8787/v1/advies?soort=zwaar", headers={"Authorization": f"Bearer {token}"})
print(json.load(urllib.request.urlopen(req, timeout=5)))
```

## Endpoints

- **`GET /v1/usage`** geeft `gemeten_op` en `accounts[]` terug. Elk account heeft:
  - `id`, `naam`, `eigenaar`, `dienst` en `abonnement`;
  - `vijf_uur`: is `null` als het account geen 5-uurslimiet heeft;
  - `week`;
  - `bron`, `laatst_gezien` en `betrouwbaar`. `betrouwbaar` is `false` als de meting ouder is dan 15 minuten of als de database niet bereikbaar was. Je krijgt dan de laatst bekende waarden met een `fout`-tekst erbij.
- **`GET /v1/advies?soort=zwaar|klein&overdag=true|false`** geeft `{"account": "...", "reden": "..."}` terug. Laat je `overdag` weg, dan bepaalt de klok in Europe/Amsterdam het, met overdag van 8 tot 18 uur. Past er geen account, dan is `account` gelijk aan `null`.

## Regels

De regels staan in `~/.config/usage-api/config.json`, onder `advies`:

| Instelling | Standaard | Betekenis |
|---|---|---|
| `max_pct` | 80 | Een account dat op of boven dit percentage zit (5 uur of week), slaat de service over. |
| `overdag_max_5u` | `{"account1": 50}` | Strengere grens voor de 5 uur, alleen overdag. |
| `voorkeur.zwaar` | `account2` eerst | Account2 heeft geen 5-uurslimiet. |
| `kies.klein` | `laagste` | Kiest het minst gebruikte account. |

Na een wijziging herstart je de service:

```bash
systemctl --user restart usage-api
```

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
