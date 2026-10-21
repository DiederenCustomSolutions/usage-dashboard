"""One local measurement, using only Python's standard library.

Rows follow the mockup: [label, colour, output millions, context millions].
Claude context = input + cache reads + cache writes; Codex context = input
(already includes cached input). Codex cumulative checkpoints become deltas so
a session crossing a period boundary is not charged entirely to its last turn.
No log text, account identifiers, file paths or credentials are exported.
"""

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys
import tempfile

UTC = timezone.utc
MILLION = 1_000_000


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except ValueError:
        return None


def windows(now):
    # Convert naive local wall times separately: astimezone handles the OS's
    # DST rules at each boundary, rather than reusing today's UTC offset.
    local = now.astimezone().replace(tzinfo=None)
    end = local.replace(hour=6, minute=0, second=0, microsecond=0)
    if local < end:
        end -= timedelta(days=1)
    start = (end - timedelta(days=1)).replace(hour=21, minute=30)
    return {"nacht": (start.astimezone(UTC), end.astimezone(UTC)),
            "7d": (now - timedelta(days=7), now)}


def records(path, usage_only=False):
    try:
        with path.open(encoding="utf-8", errors="replace") as source:
            for line in source:
                if usage_only and '"usage"' not in line and '"custom-title"' not in line:
                    continue
                try:
                    record = json.loads(line)
                    if isinstance(record, dict):
                        yield record
                except ValueError:
                    continue  # A running session may have an incomplete last line.
    except OSError:
        print("Warning: an unreadable session log was skipped.", file=sys.stderr)


def number(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def family(model, provider):
    model = model if isinstance(model, str) else "unknown"
    known = ("opus", "sonnet", "haiku", "fable") if provider == "claude" else ("astra", "sol", "luna")
    for key in known:
        if key in model.lower():
            return key.capitalize(), key
    # Preserve unfamiliar models instead of silently losing their tokens.
    label = model if re.fullmatch(r"[a-zA-Z0-9._:-]{1,80}", model) else "Unknown"
    return label, "other"


def safe_name(title, session_id):
    # Titles are explicitly allowed; fall back to an opaque short ID when a
    # title contains an email, path or credential-like value.
    if isinstance(title, str) and title.strip():
        title = " ".join(title.split())
        if not re.search(r"@|[A-Za-z]:[\\/]|[/\\]|sk-|AIza|-----BEGIN", title):
            return title[:80]
    return session_id[:8]


def collect(home, now):
    periods = windows(now)
    sums = {p: {s: {v: defaultdict(lambda: [0, 0]) for v in ("model", "wie")}
                for s in ("claude", "gpt")} for p in periods}
    cold = {p: [0, 0] for p in periods}
    sessions = {}

    def add(provider, model, who, at, out, context):
        for period, (start, end) in periods.items():
            if start <= at < end:
                for view, key in (("model", family(model, provider)), ("wie", who)):
                    total = sums[period][provider][view][key]
                    total[0] += out
                    total[1] += context

    for path in (home / ".claude" / "projects").glob("**/*.jsonl"):
        try:
            if path.stat().st_mtime < (now - timedelta(days=8)).timestamp():
                continue
        except OSError:
            continue
        sub = "subagents" in path.parts
        session_id, title, previous, latest = path.stem, None, None, None
        seen = set()  # Claude Code logs one usage line per content block; count each message.id once.
        for record in records(path, usage_only=True):
            if record.get("type") == "custom-title":
                title = record.get("customTitle") or title
            at = timestamp(record.get("timestamp"))
            message = record.get("message") or {}
            usage = message.get("usage") if isinstance(message, dict) else None
            if not at or not isinstance(usage, dict):
                continue
            message_id = message.get("id")
            if message_id:
                if message_id in seen:
                    latest = max(latest, at) if latest else at
                    continue
                seen.add(message_id)
            out = number(usage.get("output_tokens"))
            written = number(usage.get("cache_creation_input_tokens"))
            context = number(usage.get("input_tokens")) + number(usage.get("cache_read_input_tokens")) + written
            add("claude", message.get("model"), ("Subagents", "sub") if sub else ("Main sessions", "main"), at, out, context)
            if not sub and previous and (at - previous).total_seconds() > 3600 and written > 50_000:
                for period, (start, end) in periods.items():
                    if start <= at < end:
                        cold[period][0] += 1
                        cold[period][1] += written
            previous = at  # Preserve cachemis.py's adjacent-record heuristic.
            latest = max(latest, at) if latest else at
        if not sub and latest:
            sessions[session_id] = {"name": safe_name(title, session_id), "lastTurn": latest}

    hook_path = home / ".claude" / "cache-laatste-beurt.json"
    try:
        hooks = json.loads(hook_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        hooks = {}
    if isinstance(hooks, dict):
        for session_id, value in hooks.items():
            at = timestamp(value)
            if isinstance(session_id, str) and at and now - timedelta(days=8) <= at <= now:
                session = sessions.setdefault(session_id, {"name": safe_name(None, session_id)})
                session["lastTurn"] = at  # Stop-hook is authoritative, logs are the fallback.

    for account in ("account1", "account2", "account3"):
        for path in (home / (".codex-" + account) / "sessions").glob("**/rollout-*.jsonl"):
            try:
                if path.stat().st_mtime < (now - timedelta(days=8)).timestamp():
                    continue
            except OSError:
                continue
            model, previous = None, {"output_tokens": 0, "input_tokens": 0}
            for record in records(path):
                payload = record.get("payload") or {}
                if not isinstance(payload, dict):
                    continue
                if record.get("type") in ("turn_context", "session_meta"):
                    model = payload.get("model") or model
                if payload.get("type") != "token_count":
                    continue
                info = payload.get("info") or {}
                usage = info.get("total_token_usage") if isinstance(info, dict) else None
                at = timestamp(record.get("timestamp"))
                if not isinstance(usage, dict) or not at:
                    continue
                current = {key: number(usage.get(key)) for key in previous}
                delta = {key: value - previous[key] if value >= previous[key] else value for key, value in current.items()}
                previous = current
                add("gpt", model, (account, "acc" + account[-1]), at, delta["output_tokens"], delta["input_tokens"])

    data = {p: {s: {v: [[label, colour, counts[0] / MILLION, counts[1] / MILLION]
                       for (label, colour), counts in sorted(rows.items()) if any(counts)]
                    for v, rows in views.items()}
                for s, views in services.items()} for p, services in sums.items()}
    recent = sorted((s for s in sessions.values() if s["lastTurn"] <= now),
                    key=lambda s: s["lastTurn"], reverse=True)[:6]
    return {"generated": now.isoformat(), "DATA": data,
            "KOUD": {p: [n, tokens / MILLION] for p, (n, tokens) in cold.items()},
            "SESSIES": [{"name": s["name"], "lastTurn": s["lastTurn"].isoformat()} for s in recent],
            "windows": {p: {"start": a.isoformat(), "end": b.isoformat()} for p, (a, b) in periods.items()}}


def write_atomic(destination, data):
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=destination.name + ".", suffix=".tmp", dir=destination.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            json.dump(data, target, ensure_ascii=False, indent=2, allow_nan=False)
            target.write("\n")
        os.replace(name, destination)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home(), help="Session source root (for offline fixtures)")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "usage-by-model.json")
    parser.add_argument("--now", type=timestamp, default=None, help="ISO timestamp, for reproducible measurements")
    args = parser.parse_args()
    result = collect(args.home, args.now or datetime.now(UTC))
    write_atomic(args.output, result)
    print("Usage measurement written (2 periods, totals only).")


if __name__ == "__main__":
    main()
