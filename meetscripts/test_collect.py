"""Offline checks: period attribution, cumulative counters, cache, hook privacy."""

from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
from uuid import uuid4

import collect


class CollectorTests(unittest.TestCase):
    def setUp(self):
        # Python 3.14's Windows mode=0700 temporary directories exclude the
        # managed sandbox identity. Use ordinary inherited workspace ACLs.
        self.home = Path(__file__).resolve().parent / ("fixture-" + uuid4().hex)
        self.home.mkdir()
        self.addCleanup(shutil.rmtree, self.home)
        self.now = datetime.now(timezone.utc)
        self.start, self.end = collect.windows(self.now)["nacht"]

    def log(self, relative, entries):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(e) for e in entries) + '\n{partial', encoding="utf-8")

    def claude(self, at, model="claude-sonnet", out=100, write=0):
        return {"timestamp": at.isoformat(), "message": {"model": model, "usage": {
            "output_tokens": out, "input_tokens": 10, "cache_read_input_tokens": 20,
            "cache_creation_input_tokens": write}}}

    def codex(self, at, output, inputs):
        return {"timestamp": at.isoformat(), "payload": {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": inputs, "output_tokens": output,
                                  "cached_input_tokens": inputs // 2}}}}

    def test_local_night_and_pre_six(self):
        local_start, local_end = self.start.astimezone(), self.end.astimezone()
        self.assertEqual((local_start.hour, local_start.minute), (21, 30))
        self.assertEqual((local_end.hour, local_end.minute), (6, 0))
        before = local_end.replace(hour=5)
        early_end = collect.windows(before)["nacht"][1].astimezone()
        self.assertEqual(early_end.date(), (before - timedelta(days=1)).date())

    def test_claude_boundaries_roles_unknown_and_cold(self):
        self.log(".claude/projects/project/abcdefgh-long.jsonl", [
            {"type": "custom-title", "customTitle": "Build dashboard"},
            self.claude(self.start - timedelta(seconds=1), out=7),
            self.claude(self.start, out=100),
            self.claude(self.start + timedelta(hours=2), out=200, write=60_000),
            self.claude(self.end, out=900)])
        self.log(".claude/projects/project/subagents/agent-123.jsonl", [
            self.claude(self.start, model="future-model", out=50)])
        result = collect.collect(self.home, self.now)
        rows = result["DATA"]["nacht"]["claude"]
        self.assertEqual(sum(r[2] for r in rows["model"]), 350 / 1e6)
        self.assertEqual(sum(r[2] for r in rows["wie"]), 350 / 1e6)
        self.assertEqual(result["KOUD"]["nacht"], [1, .06])
        self.assertTrue(any(r[0] == "future-model" for r in rows["model"]))
        self.assertEqual(len(result["SESSIES"]), 1)
        self.assertEqual(result["SESSIES"][0]["name"], "Build dashboard")

    def test_codex_deltas_model_change_duplicates_and_reset(self):
        self.log(".codex-account1/sessions/day/rollout-one.jsonl", [
            {"type": "turn_context", "payload": {"model": "gpt-6-sol"}},
            self.codex(self.start - timedelta(seconds=1), 100, 1000),
            self.codex(self.start, 150, 1500),
            self.codex(self.start, 150, 1500),
            {"type": "turn_context", "payload": {"model": "gpt-6-astra"}},
            self.codex(self.start + timedelta(minutes=1), 180, 1900),
            self.codex(self.start + timedelta(minutes=2), 10, 100),
            self.codex(self.end, 90, 900)])
        data = collect.collect(self.home, self.now)["DATA"]["nacht"]["gpt"]
        models = {r[0]: r[2:] for r in data["model"]}
        self.assertEqual(models, {"Astra": [40 / 1e6, 500 / 1e6], "Sol": [50 / 1e6, 500 / 1e6]})
        self.assertEqual(data["wie"], [["account1", "acc1", 90 / 1e6, 1000 / 1e6]])

    def test_hook_overrides_log_and_rejects_sensitive_title(self):
        self.log(".claude/projects/project/abcdefgh-long.jsonl", [
            {"type": "custom-title", "customTitle": "person@example.com"}, self.claude(self.start)])
        hook = self.home / ".claude/cache-laatste-beurt.json"
        hook.write_text(json.dumps({"abcdefgh-long": self.now.isoformat()}), encoding="utf-8")
        result = collect.collect(self.home, self.now)
        self.assertEqual(result["SESSIES"], [{"name": "abcdefgh", "lastTurn": self.now.isoformat()}])
        self.assertNotIn("example.com", json.dumps(result))

    def test_empty_and_atomic_write(self):
        result = collect.collect(self.home, self.now)
        self.assertEqual(result["SESSIES"], [])
        self.assertEqual(result["DATA"]["nacht"]["claude"]["model"], [])
        destination = self.home / "output.json"
        collect.write_atomic(destination, result)
        self.assertEqual(json.loads(destination.read_text(encoding="utf-8")), result)
        self.assertEqual(list(self.home.glob("*.tmp")), [])

    def test_stop_hook_only_keeps_ids_and_times(self):
        spec = importlib.util.spec_from_file_location("stop_hook", Path(__file__).with_name("stop-hook.py"))
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        destination = self.home / ".claude/cache-laatste-beurt.json"
        with patch.object(Path, "home", return_value=self.home):
            for sid in ("session-a", "session-b"):
                with patch("sys.stdin", io.StringIO(json.dumps({"session_id": sid, "transcript_path": "secret", "content": "private"}))):
                    hook.main()
            with patch("sys.stdin", io.StringIO('{"session_id":"../../bad"}')):
                hook.main()
        state = json.loads(destination.read_text(encoding="utf-8"))
        self.assertEqual(set(state), {"session-a", "session-b"})
        self.assertTrue(all(collect.timestamp(v) for v in state.values()))
        self.assertNotIn("secret", destination.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
