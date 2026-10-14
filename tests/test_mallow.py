"""Quick checks for Mallow's harness and settings helpers. Standard library only.
Run from the Mallow folder:  python -m unittest discover tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="mallow-test-"))
os.environ["HOME"] = os.environ["USERPROFILE"] = str(TMP)          # keep ~/.mallow inside the temp folder
os.environ["CLAUDE_CONFIG_DIR"] = str(TMP / ".claude")
sys.path.insert(0, str(ROOT))
import harness  # noqa: E402
import mallow   # noqa: E402


class RunnerKey(unittest.TestCase):
    def test_build_and_test_commands_are_recognised(self):
        cases = {
            "npm test": "npm test", "cd C:/x && npm test": "npm test", "npm run build": "npm run build",
            "./gradlew build": "gradlew", ".\\gradlew.bat test": "gradlew", "python -m pytest -q": "pytest",
            "uv run pytest": "pytest", "FOO=1 cargo test": "cargo test", "timeout 300 cargo test": "cargo test",
            'cd "/c/Users/Chris/Desktop/Halo Ring"; cargo build --release': "cargo build",
        }
        for cmd, key in cases.items():
            self.assertEqual(harness.runner_key(cmd), key, cmd)

    def test_commands_whose_output_is_the_point_are_left_alone(self):
        for cmd in ["cat README.md", "sed -n 1,200p x.lua", "git diff", "grep -n foo", "npm run dev",
                    'cd "C:/Users/Chris/Desktop/Build a raft"; sed -n 1,9p f', "cargo build | tail -5",
                    "npm test && npm run lint", 'echo "==="', "python - <<EOF", "mkdir -p a"]:
            self.assertIsNone(harness.runner_key(cmd), cmd)

    def test_rules_only_apply_in_their_projects(self):
        rules = {"bash": {"enabled": True, "commands": [{"key": "cargo build", "projects": ["C:\\Users\\Me\\Halo"]}]}}
        self.assertIsNotNone(harness.match_rule("cargo build", "C:\\Users\\Me\\Halo\\rust", rules))
        self.assertIsNone(harness.match_rule("cargo build", "C:\\Users\\Me\\Other", rules))


@unittest.skipUnless(shutil.which("bash") and shutil.which("awk") and shutil.which("tee"), "needs bash, awk and tee")
class WrapCommand(unittest.TestCase):
    def test_keeps_exit_code_errors_and_tail_and_saves_full_log(self):
        log = TMP / "out.log"
        gen = 'for i in $(seq 1 300); do echo "line $i"; [ $i = 20 ] && echo "error: E0308"; done; exit 3'
        r = subprocess.run(["bash", "-c", harness.wrap_command(gen, 10, log)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 3)
        self.assertIn("21: error: E0308", r.stdout)
        self.assertIn("line 300", r.stdout)
        self.assertNotIn("line 150", r.stdout)
        self.assertEqual(len(log.read_text().splitlines()), 301)

    def test_short_output_is_unchanged(self):
        r = subprocess.run(["bash", "-c", harness.wrap_command("echo a; echo error b; echo c", 10, TMP / "o2.log")],
                           capture_output=True, text=True)
        self.assertEqual(r.stdout, "a\nerror b\nc\n")


class SettingsEdits(unittest.TestCase):
    def setUp(self):
        (TMP / ".claude").mkdir(exist_ok=True)
        self.path = TMP / ".claude" / "settings.json"
        self.h = mallow.Harness(TMP, mallow.ReportCache(TMP / "none"))

    def write(self, text):
        self.path.write_text(text, encoding="utf-8")

    def test_tuneup_on_then_off_restores_exactly(self):
        self.write('{"model": "opus", "promptSuggestionEnabled": true, "env": {"A": "1"}}')
        before = json.loads(self.path.read_text())
        t = mallow.Tuneups(self.h)
        for tid in ("suggestions", "checkins"):
            self.assertTrue(t.set(tid, True)[0])
        on = json.loads(self.path.read_text())
        self.assertIs(on["promptSuggestionEnabled"], False)
        self.assertEqual(on["env"]["CLAUDE_CODE_GOAL_CHECKIN_MINUTES"], "0")
        for tid in ("suggestions", "checkins"):
            self.assertTrue(t.set(tid, False)[0])
        self.assertEqual(json.loads(self.path.read_text()), before)

    def test_byte_order_mark_is_read(self):
        self.path.write_bytes(b"\xef\xbb\xbf" + b'{"model": "opus"}')
        ok, _ = self.h.install()
        self.assertTrue(ok)
        self.assertTrue(self.h.installed())
        self.assertTrue(self.h.uninstall()[0])
        self.assertEqual(json.loads(self.path.read_text()), {"model": "opus"})

    def test_unreadable_settings_are_left_alone(self):
        self.write("{not json")
        ok, msg = self.h.install()
        self.assertFalse(ok)
        self.assertEqual(self.path.read_text(), "{not json")

    def test_hook_uses_exec_form(self):
        e = mallow.hook_entry()
        self.assertTrue(e["args"][0].endswith("harness.py"))


class History(unittest.TestCase):
    def test_report_cache_matches_a_full_load_and_reuses_unchanged_files(self):
        root = TMP / "projects" / "-p"
        root.mkdir(parents=True, exist_ok=True)
        f = root / "s1.jsonl"
        lines = []
        for i in range(5):
            lines.append({"type": "user", "sessionId": "s1", "cwd": "/p", "timestamp": f"2026-10-01T10:0{i}:00Z",
                          "message": {"role": "user", "content": f"task {i}"}})
            lines.append({"type": "assistant", "sessionId": "s1", "timestamp": f"2026-10-01T10:0{i}:30Z", "requestId": f"r{i}",
                          "message": {"id": f"m{i}", "model": "claude-opus-5-5", "stop_reason": "end_turn",
                                      "usage": {"input_tokens": 5, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 20000 * i,
                                                "output_tokens": 100}, "content": [{"type": "text", "text": "ok"}]}})
        f.write_text("\n".join(json.dumps(x) for x in lines))
        rc = mallow.ReportCache(TMP / "projects")
        a = rc.get()
        full = [mallow.analyze(s) for s in mallow.load_sessions(TMP / "projects").values() if s.calls]
        self.assertEqual(round(a["sessions"][0]["cost"]), round(full[0]["cost"]))
        rc.built = 0
        self.assertIs(rc.get(), a)                    # nothing changed, so nothing was rebuilt


if __name__ == "__main__":
    unittest.main()
