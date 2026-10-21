"""Optional Claude Stop hook. Not installed by collect.py.

Consumes hook JSON on stdin; stores only {session_id: ISO UTC timestamp}.
No network, transcript reads, polling, or changes to settings.json.
"""

from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys

from collect import write_atomic


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return
    session_id = payload.get("session_id") if isinstance(payload, dict) else None
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id):
        return
    destination = Path.home() / ".claude" / "cache-laatste-beurt.json"
    # Serialize read/modify/write across simultaneous Stop hooks without polling.
    # OS locks release automatically if a hook is interrupted.
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.with_suffix(".lock").open("a+b") as lock:
        if sys.platform == "win32":
            import msvcrt
            lock.seek(0, 2)
            if not lock.tell():
                lock.write(b"\0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            try:
                state = json.loads(destination.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                state = {}
            if not isinstance(state, dict):
                state = {}
            # Keep only valid ID -> timestamp entries, never arbitrary hook data.
            from collect import timestamp
            state = {key: value for key, value in state.items()
                     if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key) and timestamp(value)}
            state[session_id] = datetime.now(timezone.utc).isoformat()
            write_atomic(destination, state)
        finally:
            if sys.platform == "win32":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


if __name__ == "__main__":
    main()
