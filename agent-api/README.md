# Usage-leesservice voor agents

Agents vragen hier het actuele verbruik per abonnement op: dezelfde cijfers als het dashboard. Welk account een agent neemt, bepalen de agents zelf (agents-infra); dat hoort niet in deze repo. De service draait op de agents-pc, leest dezelfde gegevens als het dashboard en bewaart daarnaast centrale verbruikshistorie. Lezen gebruikt het lees-token; inname gebruikt een apart token per pc.

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

Elke bestaande Firebase-lezing bewaart de metingen ook in SQLite (`node:sqlite`, zonder extra pakketten), standaard in `historie.sqlite` naast de config. Met `historie_bestand` kies je een ander pad, op dezelfde manier als `cache_bestand`. Een Firebase-meting wordt toegevoegd als `laatst_gezien` nieuwer is dan de vorige niet-Codex-meting van dat account; een later opgenomen Codex-meting blokkeert die niet. Bestaande regels worden nooit aangepast of gewist. Ook de resets en ChatGPT-reset-tegoeden met vervaldata blijven bewaard.

`GET /v1/verloop?account=account1&sinds=2026-11-01T00:00:00Z&max=500` geeft `{ metingen: [...] }`, nieuwste `laatst_gezien` eerst. Alle filters zijn optioneel; `sinds` is inclusief en `max` is standaard 500. Het endpoint gebruikt dezelfde token- en adrescontrole als `/v1/usage`. Zonder beschikbare historie is het antwoord `{ metingen: [], fout: "geen historie" }`. SQLite draait in een worker; fouten daarin laten `/v1/usage` gewoon antwoorden. Er komt geen timer, poll of extra Firebase-lezing bij.

## Centrale database

SQLite draait uitsluitend in één worker-thread. De tabellen zijn:

| Tabel | Inhoud |
| --- | --- |
| `metingen` | Limietpercentages, resets en reset-tegoeden per account; ook Codex-metingen |
| `berichten` | Claude-berichten met model, sessie, titel/project, tokens en prijs; uniek op `id` |
| `codex` | Codex-tokenregels met account, werkmap, tokens, USD en limietpercentages; uniek op `id` |
| `codex_verwijderd` | Bevestigde verwijderingen van bewezen Codex-dubbelen, uniek op `pc, id` |
| `klussen` | Opeenvolgende klusstanden; ontdubbeld via een vingerafdruk van de inhoud |
| `klus_rondes` | Limietstanden, sessie, model, denkdiepte, weekresettijdstip en exitcode per `(pc, klus_id, ronde)` |
| `inname_log` | Audit per blok: pc, tabel, tijd, ontvangen/nieuwe regels en positie |

`node agent-api/inname-token.mjs <pc>` maakt een inname-token voor een pc-naam van 1–32 kleine letters, cijfers of streepjes. Het token verschijnt één keer op stdout; bewaar het veilig. Alleen de SHA-256-hash komt in `inname.json` naast de config (modus 0600). Opnieuw uitvoeren vervangt het token voor die pc. `USAGE_API_CONFIG` kiest de config; `inname_bestand` kiest een ander tokenbestand. De dienst leest wijzigingen bij de volgende inname, zonder herstart of timer.

`POST /v1/inname` gebruikt dit pc-token als Bearer-token en dezelfde adrescontrole als de lees-endpoints. Stuur JSON met `tabel` (`berichten`, `codex`, `klussen`, `codex_verwijderd` of `klus_rondes`), `rijen` (1–5000 objecten) en optioneel `positie` (geheel getal ≥ 0). Gebruik voor `klus_rondes` een niet-lege tekst `klus_id` en een positief geheel getal `ronde`. Gebruik bij de andere tabellen een niet-lege tekst `id`. De body mag maximaal 8 MiB zijn. De dienst vult `pc` en `ontvangen_op` zelf in en negeert onbekende kolommen. Een geslaagde inname geeft bijvoorbeeld `{ "ok": true, "protocol": 2, "tabel": "codex", "ontvangen": 2, "nieuw": 2, "positie": null, "backup": "2026-11-14" }`. Herhalen voegt dezelfde regels één keer toe. De inhoud van de klus bepaalt de vingerafdruk. Zonder beschikbare historie volgt HTTP 503. Het lees-token geeft geen toegang tot inname.

`protocol: 2` bevestigt ondersteuning voor `klussen.effort`, `codex_verwijderd` en limietcorrecties. Een pc kan het protocol opvragen met `{"tabel":"klussen","positie":0,"rijen":[],"protocol":2}`. Deze peiling meldt ook de recentste back-updatum en schrijft geen innameblok. Een antwoord zonder protocolveld bevestigt de oude klusvelden tot en met `status`.

Een peiling met `{"tabel":"klussen","positie":0,"rijen":[],"protocol":3}` waarvan het antwoord `protocol: 3` bevat, bevestigt `klus_rondes`. Stuur die tabel vervolgens met `protocol: 3`. De pc houdt rondes lokaal tot de API het blok met protocol 3 bevestigt. Een herlevering met gewijzigde velden werkt dezelfde ronde bij. `nieuw` telt ingevoegde en gewijzigde rondes. Bestaande verzoeken zonder protocol of met protocol 2 krijgen normaal een antwoord met `protocol: 2`, zodat oudere pc-clients hun bevestigingen blijven verwerken.

Een ronde bevat `klus_id`, `ronde`, `account`, `model`, `effort`, `sessie_id`, `start`, `eind`, `vijf_uur_voor`, `vijf_uur_na`, `week_voor`, `week_na`, `week_reset` en `exitcode`. De percentages gelden voor het account van die ronde. Een ontbrekende meting is `null` en een gemeten nul blijft `0`. `week_reset` bevat het weekresettijdstip uit de nameting, in Unix-seconden, of `null` als het onbekend is. `sessie_id` kan `null` zijn als er geen eenduidige sessie is.

Stuur `codex_verwijderd` met `protocol: 2` en de ids die lokaal met de oorspronkelijke rollout zijn bewezen. De dienst bewaart die ids per geauthenticeerde pc en weigert herinname van een verwijderde regel door diezelfde pc, ook als de verwijdering vóór de eerste levering aankwam. `nieuw` telt de fysiek verwijderde rijen. Een herlevering van een prijs vult alleen een ontbrekend bedrag bij dezelfde pc, id en model. Een pc kan onder protocol 2 een bewezen limietregel met `limietcorrectie: true`, nul tokens en nul USD herleveren. Als de regel al bestaat, moeten pc, id, model, sessie, werkmap, tijdstip, account en beide limietpercentages overeenkomen.

Voorbeeldbody (ontbrekende kolommen worden `null`):

```json
{"tabel":"codex","positie":42,"rijen":[{"id":"logregel-42","tijd":"2026-11-14T10:00:00Z","account":"account1","werkmap":"C:\\werk\\app","model":"sol","input":100,"cached_input":40,"output":20,"reasoning":5,"usd":0.0123,"week_pct":30}]}
```

Deze vier leesendpoints gebruiken hetzelfde lees-token en dezelfde adrescontrole als `/v1/usage`. Een pc-token geeft hier geen toegang.

| Endpoint | Parameters en antwoord |
| --- | --- |
| `GET /v1/verbruik` | `van`, `tot`: geldige UTC-dagen (`JJJJ-MM-DD`), beide inclusief, maximaal 400 dagen. Standaard `tot` vandaag UTC en `van` zes dagen eerder. `groep`: komma-lijst uit `dag,uur,account,model,klus,sessie`, standaard `dag,account`. `uur` is het UTC-klokuur, of met `uurstart=<ISO-tijdstip>` het aantal hele uren sinds dat tijdstip (geheel getal). Met `uur` of `sessie` komen `groot_usd` (berichten boven 150k context) en `subagent_usd` mee; `sessie` voegt `titel`, `project`, `eerste`, `laatste` toe. `bron`: optioneel `claude` of `codex`. Antwoord: `van`, `tot`, `groep[]`, `rijen[]`, oplopend gesorteerd op de gekozen velden en bron. |
| `GET /v1/klussen` | `sinds`: optioneel ISO-tijdstip met tijdzone, inclusief filter op `start`. `max`: 1–1000, standaard 100. Antwoord `klussen[]`: per id de nieuwste stand (grootste `rij`), nieuwste start eerst. Velden: `id`, `pc`, `klusmap`, `account`, `model`, `start`, `eind`, `week_voor`, `week_na`, `vijf_uur_voor`, `vijf_uur_na`, `input`, `output`, `usd`, `pr`, `exitcode`, `gelukt`, `status`, `effort`. Als er rondes zijn voor die pc en klus-id, bevat `rondes` die rondes op oplopend rondenummer. |
| `GET /v1/verloop` | `account`, `sinds` (ISO-tijdstip met tijdzone, inclusief), `max` (positief geheel getal, standaard 500), `bron` (bijvoorbeeld `codex` of `api`): alle filters optioneel. Antwoord `metingen[]`, nieuwste `laatst_gezien` eerst. Zonder bronfilter komen ook Codex-metingen mee. |
| `GET /v1/backup` | Geen parameters. Nieuwste `usage-JJJJ-MM-DD.sqlite` als gzip-stroom: `Content-Type: application/gzip`, `X-Backup-Datum: JJJJ-MM-DD`. Geen bestand: HTTP 404 met `{"fout":"geen back-up"}`. |

Elke verbruiksrij bevat de gekozen groepvelden plus `bron`, `regels`, `input`, `output`, `cache_lees`, `cache_schrijf`, `usd`, `usd_bekend` en `regels_zonder_prijs`. De API geeft `usd: null` zodra minstens één regel geen prijs heeft. `usd_bekend` telt de bekende bedragen op en is nul als geen enkele prijs bekend is. Beide bedragen worden afgerond op vier decimalen. Claude krijgt account `claude` en klus `titel`, of `project` als de titel `null` is; cache-schrijven telt de 5m- en 1u-tokens op. Bij Codex is de klus de mapnaam na de laatste `/` of `\`, output is inclusief reasoning en cache-lezen is `cached_input`. Ontbrekende aantallen tellen als nul. De bronnen blijven altijd apart gegroepeerd.

Voorbeeld `/v1/verbruik?van=2026-11-14&tot=2026-11-14`:

```json
{"van":"2026-11-14","tot":"2026-11-14","groep":["dag","account"],"rijen":[{"dag":"2026-11-14","account":"account1","bron":"codex","regels":2,"input":100,"output":25,"cache_lees":40,"cache_schrijf":0,"usd":null,"usd_bekend":0.0123,"regels_zonder_prijs":1}]}
```

Voorbeeld `/v1/verloop?account=account1&bron=codex&max=1`:

```json
{"metingen":[{"id":1,"gelezen_op":"2026-11-14T10:01:00.000Z","account":"account1","dienst":"chatgpt","laatst_gezien":"2026-11-14T10:00:00Z","vijf_uur_pct":null,"vijf_uur_reset":null,"week_pct":30,"week_reset":null,"bron":"codex","reset_tegoeden":null,"reset_tegoeden_json":null}]}
```

Ongeldige parameters geven HTTP 400, een ontbrekend/verkeerd lees-token HTTP 401. Bij onbeschikbare historie geven `/v1/verbruik` en `/v1/klussen` HTTP 503; `/v1/verloop` behoudt zijn bestaande antwoord met `metingen: []` en `fout: "geen historie"`.

De eerste schrijfactie van elke UTC-dag maakt na de transactie een SQLite-back-up, standaard in `~/.local/share/usage-api/backup/usage-JJJJ-MM-DD.sqlite`. `backup_map` kiest een andere map. Relatieve paden voor `backup_map` en `inname_bestand` worden naast de config opgelost; `~` in een ingestelde waarde wordt niet uitgevouwen, dus gebruik een absoluut pad of laat de standaard gelden. `install.sh` maakt de back-upmap (0700) en een leeg `inname.json` (0600) aan als ze ontbreken. Bestaande dagbestanden blijven staan; back-ups met een bestandstijd ouder dan 14 dagen worden opgeruimd. Download via `/v1/backup`; het inname-antwoord noemt de back-updatum (of `null` als er geen is). Een back-upfout wordt één regel op stderr en houdt de inname niet tegen. Nieuwe Codex-regels leveren ook historie met bron `codex` op als hun limietpercentages afwijken van de vorige Codex-meting van dat account, inclusief oudere tijden en een weekreset naar nul.

## Herstel van de meet-Chromes

`herstel-meetchromes.sh` start één keer per aanleiding, nooit op een timer:

- **Opstarten van de agents-pc** (`usage-herstel@boot.service`): twee minuten na de start kijkt het of alle vier de Chromes draaien en echt meten. Zo niet, dan herstart het ze en stuurt het één Telegram-bericht.
- **Chrome-update** (`usage-herstel-chrome.path`): zodra apt klaar is, herstart het de vier Chromes. Anders start Chrome zichzelf opnieuw, buiten zijn service en zonder de extensie (4-11-2026).

Lukt het herstel niet, dan komt er een Telegram-bericht via het profiel `github-it`. Het logboek staat in `journalctl --user -u 'usage-herstel@*'`.

## Inloglink vanuit het dashboard

Een tegel van een uitgelogd account heeft een knop "Log in". Die zet een versleuteld verzoek in `meta.loginRequests`; `usage-api` heeft daarvoor één stream op `meta` (push, geen timer), start `usage-inloglink <profiel>` en zet de link versleuteld in `meta.loginLinks`. De link werkt alleen in het tailnet en 30 minuten. Welk profiel bij welke meet-Chrome hoort, staat in de profielenlijst (hieronder). Handmatig: `usage-inloglink <naam> [minuten] [--tailnet]`.

## Profielenlijst en nieuwe meet-gebruiker

`~/.config/usage-api/profielen.json` (niet in git; `profielen.example.json` is het begin) is de enige lijst: `naam`, `pid` (wordt na de start ingevuld), `diensten`, `start` (`unit` = systemd `chrome-usage@<naam>`, `script` = `usage-chrome-script.py <naam>`), `debugpoort`, `webpoort` en `extern`. Inloglink, herstel, autoupdate, Kevin-script en de Chrome-unit lezen die; `node profielen.mjs names|get|set|sync-env`.

**Toevoegen:** knop "Add measuring profile" in het dashboard, of `usage-gebruiker-toevoegen <naam> [--extern] [--min N]` (uitvoer: laatste regel is de link). Het maakt de poorten, start de Chrome (altijd met `--password-store=basic`), zet de koppeling en het pid via DevTools en geeft een inloglink. Standaard is dat een tailnet-link. Maximaal 8 profielen.

**Publieke link (Funnel), alleen als je het bewust aanzet:** een profiel met `extern: true` (niet de standaard; `--extern` bij het toevoegen, of `node profielen.mjs set <naam> extern true|false`) krijgt een https-link via `tailscale funnel` op poort 8443: token van 64 hex, hooguit 60 minuten, daarna gaat Funnel uit (ook na een crash en bij elke start van de agents-pc). Tijdens de link staat er een inlogscherm van die Chrome op internet; wie de link heeft, kan het gebruiken. Eisen: Funnel moet voor deze node aan staan in het tailnet, en poort 8443 moet vrij zijn. Nieuwe gebruikers, Rob, Raimond en Kevin staan op `extern: false`.

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
