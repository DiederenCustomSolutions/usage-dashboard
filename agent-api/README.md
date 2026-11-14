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

`/v1/usage?ververs=1` is de verversknop (zoals Ververs in de werklijst): de service vraagt meteen een meting (hooguit eens per 10 s) en wacht tot 15 s op de nieuwe meting. Het antwoord heeft dan `ververst: true` of `false` (geen nieuwe meting binnen 15 s; je krijgt de laatste).

## Historie

Elke bestaande Firebase-lezing bewaart de metingen ook in SQLite (`node:sqlite`, zonder extra pakketten), standaard in `historie.sqlite` naast de config. Met `historie_bestand` kies je een ander pad, op dezelfde manier als `cache_bestand`. Het bestand groeit alleen als `laatst_gezien` voor een account nieuwer is dan de laatst opgeslagen meting; bestaande regels worden nooit aangepast of gewist. Ook de resets en ChatGPT-reset-tegoeden met vervaldata blijven bewaard.

`GET /v1/verloop?account=account1&sinds=2026-11-01T00:00:00Z&max=500` geeft `{ metingen: [...] }`, nieuwste `laatst_gezien` eerst. Alle filters zijn optioneel; `sinds` is inclusief en `max` is standaard 500. Het endpoint gebruikt dezelfde token- en adrescontrole als `/v1/usage`. Zonder beschikbare historie is het antwoord `{ metingen: [], fout: "geen historie" }`. SQLite draait in een worker; fouten daarin laten `/v1/usage` gewoon antwoorden. Er komt geen timer, poll of extra Firebase-lezing bij.

## Herstel van de meet-Chromes

`herstel-meetchromes.sh` start één keer per aanleiding, nooit op een timer:

- **Opstarten van de agents-pc** (`usage-herstel@boot.service`): twee minuten na de start kijkt het of alle vier de Chromes draaien en echt meten. Zo niet, dan herstart het ze en stuurt het één Telegram-bericht.
- **Chrome-update** (`usage-herstel-chrome.path`): zodra apt klaar is, herstart het de vier Chromes. Anders start Chrome zichzelf opnieuw, buiten zijn service en zonder de extensie (4-11-2026).

Lukt het herstel niet, dan komt er een Telegram-bericht via het profiel `github-it`. Het logboek staat in `journalctl --user -u 'usage-herstel@*'`.

## Inloglink vanuit het dashboard

Een tegel van een uitgelogd account heeft een knop "Log in". Die zet een versleuteld verzoek in `meta.loginRequests`; `usage-api` heeft daarvoor één stream op `meta` (push, geen timer), start `usage-inloglink <profiel>` en zet de link versleuteld in `meta.loginLinks`. De link werkt alleen in het tailnet en 30 minuten. Welk profiel bij welke meet-Chrome hoort, staat in `inlog_profielen` van `config.json`. Handmatig: `usage-inloglink <rob|raimond|kevin|kevin-lxdg> [minuten]`.

## Installeren en testen

Installeren op de agents-pc:

```bash
bash ~/usage-dashboard-proef/agent-api/install.sh
```

Het script maakt de config en het token aan, haalt de sleutel uit de meet-Chrome en zet de user-service `usage-api` en het herstel aan.

Testen:

```bash
node --test agent-api/test/agent-api.test.mjs
```
