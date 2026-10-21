"""Compare real measurement with supplied scripts, with identical time windows.

Reference scripts execute in memory, unmodified on disk. Their fixed UTC night
is replaced with the measurement's local night, and 'now' is frozen. No session
names or paths are written to the report.
"""
import contextlib
import io
import json
from pathlib import Path
import re


def main():
    repo = Path(__file__).resolve().parents[1]
    data = json.loads((repo / "usage-by-model.json").read_text(encoding="utf-8"))
    window = data["windows"]["nacht"]
    reports = {}
    for filename, variable in (("modelmix2.py", "tot"), ("codexmix.py", "res"), ("cachemis.py", "mis")):
        source = (repo.parent / "meetscripts" / filename).read_text(encoding="utf-8")
        source = source.replace("nu = dt.datetime.now(dt.timezone.utc)", "nu = dt.datetime.fromisoformat(" + repr(data["generated"]) + ")")
        source = re.sub(r"dt\.datetime\(2026,10,20,21,30,tzinfo=dt\.timezone\.utc\)", "dt.datetime.fromisoformat(" + repr(window["start"]) + ")", source)
        source = re.sub(r"dt\.datetime\(2026,10,21,6,0,tzinfo=dt\.timezone\.utc\)", "dt.datetime.fromisoformat(" + repr(window["end"]) + ")", source)
        namespace = {}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(source, filename, "exec"), namespace)
        reports[filename] = namespace[variable]
    report = {"generated": data["generated"], "windows": data["windows"], "claude": {}, "cold": {}, "codex": {}}
    for period in ("nacht", "7d"):
        claude = data["DATA"][period]["claude"]
        reference = reports["modelmix2.py"][period]
        expected_output = sum(value for key, value in reference.items() if key[-1] == "out")
        expected_context = sum(value for key, value in reference.items() if key[-1] == "cr")
        actual_output = round(sum(row[2] * 1e6 for row in claude["model"]))
        actual_context = round(sum(row[3] * 1e6 for row in claude["model"]))
        assert (actual_output, actual_context) == (expected_output, expected_context), "Claude reference mismatch"
        assert actual_output == round(sum(row[2] * 1e6 for row in claude["wie"]))
        report["claude"][period] = {"output_tokens": actual_output, "context_tokens": actual_context, "matches_reference": True}
        reference_cold = reports["cachemis.py"][period]
        actual_cold = [data["KOUD"][period][0], round(data["KOUD"][period][1] * 1e6)]
        assert actual_cold == reference_cold, "Cold restart reference mismatch"
        report["cold"][period] = {"count": actual_cold[0], "rewritten_tokens": actual_cold[1],
                                   "reference": reference_cold, "matches_reference": actual_cold == reference_cold}
        codex = data["DATA"][period]["gpt"]
        reference_codex = reports["codexmix.py"][period]
        legacy_output = sum(value for key, value in reference_codex.items() if key[-1] == "out")
        actual_output = round(sum(row[2] * 1e6 for row in codex["model"]))
        assert actual_output == round(sum(row[2] * 1e6 for row in codex["wie"]))
        report["codex"][period] = {"output_tokens": actual_output, "legacy_last_session_total": legacy_output,
                                   "difference": actual_output - legacy_output,
                                   "note": "Collector attributes checkpoint deltas to their event time/model; legacy assigns final session total to last event/first model."}
    (repo.parent / "test-reference.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("Reference comparison passed: Claude and cold exact; Codex period-attribution differences recorded.")


if __name__ == "__main__":
    main()
