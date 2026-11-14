# Ontwerp: centrale usage-database (14-11-2026)

Eén bron: `historie.sqlite` van `usage-api` op de agents-pc (pad uit `config.historie_bestand`, standaard `~/.config/usage-api/historie.sqlite`). Alleen de dienst schrijft, via één worker-thread. Er komt alleen bij (`INSERT OR IGNORE`), niets wordt overschreven of gewist. Geen PostgreSQL, geen timers.

## Schema (`PRAGMA user_version = 2`)
| Tabel | Inhoud | Unieke sleutel |
|---|---|---|
| `metingen` (bestaat) | limiet-%-verloop per account: 5 uur, week, resets, reset-tegoeden; `bron` = api/scraped/schatting/**codex** | `UNIQUE(account, laatst_gezien)` |
| `berichten` | Claude, per bericht: tijd, tijd_eind, bron, sessie_id, titel, project, model, tokens (input, output, cache_lees, cache_schrijf_5m/1u), koud, subagent, prijs | `id` (message.id) |
| `codex` | GPT, per token_count: tijd, account, sessie_id, werkmap, model, input, cached_input, output, reasoning, usd, vijf_uur_pct, week_pct | `id` (sha256 van de bron) |
| `klussen` | elke klusstand als eigen regel (lopend, klaar ...): id, klusmap, account, model, start, eind, week/5u voor-na, tokens, usd, pr, exitcode, gelukt, status | `vingerafdruk` = sha256 van alle velden |
| `inname_log` | audit: pc, tabel, tijd, ontvangen, nieuw, positie | — |

Elke regel in berichten/codex/klussen krijgt `pc` (uit het token, nooit uit de body) en `ontvangen_op`. Een codex-regel met een %-waarde levert ook een `metingen`-regel (bron `codex`), maar alleen als het % anders is dan de vorige codex-meting van dat account. Zo staat het weekverloop uit de Codex-logs in hetzelfde verloop.

## Wie schrijft, via welk endpoint
- **Meet-Chromes → Firebase → usage-api**: elke Firebase-lezing die er toch al is → `metingen` (zoals PR 14).
- **Robs pc → `POST /v1/inname`**: Bearer-token per pc (`~/.config/usage-api/inname.json` bewaart alleen de sha256; aanmaken met `node agent-api/inname-token.mjs <pc>`, dat het token één keer naar stdout schrijft). Body `{"tabel":"berichten|codex|klussen","positie":N,"rijen":[...]}`, max 5000 rijen. Antwoord `{"ok":true,"tabel","ontvangen","nieuw","positie","backup":"JJJJ-MM-DD"|null}`. Twee keer insturen = 0 nieuw.
- Triggers op Robs pc (geen timer): de Stop-hook (`verbruik-log.py` start `verbruik-inname.py` los op de achtergrond, de hook wacht niet) en het einde van `start-klus.ps1`. `verbruik-inname.py` stuurt per tabel de regels met `rowid` > positie (tabel `inname_positie` in verbruik.db); de positie gaat pas omhoog na `ok`. Dienst onbereikbaar: time-out 2 s, exit 0, alles gaat mee bij de volgende trigger. Klussen (klein) gaan elke keer helemaal mee; de vingerafdruk ontdubbelt.
- **Lezen** (lees-token, zoals `/v1/usage`): `GET /v1/verloop?account&sinds&max` (bestaat), `GET /v1/verbruik?van&tot&groep=dag,account,model,klus&bron=claude|codex`, `GET /v1/klussen?sinds&max`, `GET /v1/backup` (nieuwste back-up, gzip).

## Back-up
Bij de eerste schrijfactie op een nieuwe dag (UTC) doet de worker `VACUUM INTO ~/.local/share/usage-api/backup/usage-JJJJ-MM-DD.sqlite` en wist back-ups ouder dan 14 dagen. Kopie op Robs pc: het inname-antwoord noemt de datum van de nieuwste back-up; mist die in `~\.claude\verbruik\centraal-backup\`, dan haalt `verbruik-inname.py` hem op via `GET /v1/backup` (3 bewaren). Gekozen omdat het geen extra trigger, cron of ssh nodig heeft.

## Migratie
1. De dienst maakt de nieuwe tabellen zelf aan (`CREATE TABLE IF NOT EXISTS`); bestaande `metingen` blijven.
2. Eenmalig op Robs pc: `python verbruik-inname.py --alles` stuurt verbruik.db (berichten ~80k, codex ~39k, klussen) in blokken van 2000. Idempotent, dus herhalen kan.
3. Firebase, de extensie en het legacy-blok blijven ongewijzigd. verbruik.db blijft de lokale bron en terugval.

## Bekende grens
Een Claude-bericht dat na de inname nog groeit (zelfde id, meer tokens) wordt centraal niet bijgewerkt: niets overschrijven gaat voor.
