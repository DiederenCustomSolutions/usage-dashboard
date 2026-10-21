# Local usage measurement

Run once from the repository: `python meetscripts/collect.py`. Reads the current
user's Claude project logs and Codex account1/2/3 session logs. Writes
`usage-by-model.json` beside `index.html` atomically, without network access.
The generated file is ignored by Git. Copying it to another dashboard host is a
separate, explicit step; this does not write to the encrypted bin.

`nacht` is the last completed local 21:30–06:00 window (before 06:00 it uses the
preceding completed night). `7d` is the rolling last 168 hours. The JSON contains
`generated`, `DATA`, `KOUD`, `SESSIES` and `windows`. The `DATA` rows are
`[label, colour, output_millions, context_millions]`, as in the mockup. Context
includes cache reads and writes for Claude, and input tokens for Codex (cached
input is already part of input). Unknown models remain visible.

Codex cumulative checkpoints are converted to per-event deltas and attributed to
the current model and time. This corrects `codexmix.py`, which assigns an entire
session's last cumulative total to one period and its first model. If a log starts
with a nonzero cumulative checkpoint, the first checkpoint is attributed to that
event because earlier timing is unavailable. Claude summation and cold-restart
heuristics follow the supplied scripts: a main-session gap greater than 60 minutes
and a cache write greater than 50,000 tokens counts as a cold restart.

The cache section shows the six most recent main sessions. Titles come only from
`custom-title` records, with an eight-character ID fallback. Titles containing
email addresses, paths or credential-like values use the fallback. Stop-hook
timestamps take precedence over the last usage record; logs remain the fallback
until the hook is installed. Log activity does not establish whether a session
is still open, so these are recent sessions, not a process liveness check.

`stop-hook.py` consumes hook JSON on stdin and stores only ID → ISO timestamp in
`~/.claude/cache-laatste-beurt.json`. It uses an OS lock and atomic replacement
to preserve concurrent session updates. **The hook is not installed by these
scripts.** No settings are changed. Install it separately when authorized.

The dashboard fetches the snapshot once on opening with `cache: no-store`.
Its existing display clock, hover, focus, clicks and visibility changes update
the local countdown. None of these triggers fetch or collect data. Reload after
another measurement. Missing, malformed or unreadable JSON shows “No data yet”.

Offline checks: `python -m unittest discover -s meetscripts -p test_collect.py`.
`--home`, `--output` and `--now` allow reproducible fixture measurements without
touching real hook state.

After a real measurement, `node meetscripts/test-usage-state.cjs` checks schema,
countdowns, view preferences and ordering without a browser or dependencies.
`node meetscripts/test-dashboard.cjs` runs the integration checks in headless
Edge against a temporary localhost HTTP server and saves screenshots and a
report in the parent task directory. It blocks external page requests and stops
the server and browser afterward. Edge's executable path is Windows-specific;
managed Windows sandboxes may prevent its IPC from starting. Such a failure is
reported, not replaced with mock screenshots.

`python meetscripts/verify-reference.py` is a task verification helper that needs
the three supplied source scripts in the parent task's `meetscripts` folder.
It compares the same frozen timestamp and local windows and writes an aggregate
report in the parent directory. It never changes the source scripts.
