#!/usr/bin/env python3
"""
Mallow harness: a Claude Code PreToolUse hook that trims wasteful tool calls
before they run. It never contacts a model and never approves anything:
rewritten calls still go through your normal permission prompts.

What it does
  Read  of a very large file with no line range  -> reads the first N lines,
        and tells Claude in one line how to read more.
  Bash  commands Mallow has seen print huge output -> keeps the last N lines.

Rules live in ~/.mallow/harness-rules.json (Mallow writes them from your
history; you can switch each one off in the app). Every change is logged to
~/.mallow/harness-log.jsonl so the app can show what it saved.

Any error here exits quietly, so the tool call goes ahead untouched.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

HOME = Path.home() / ".mallow"
RULES = HOME / "harness-rules.json"
LOG = HOME / "harness-log.jsonl"
CHARS_PER_TOKEN = 4

DEFAULT_RULES = {
    "enabled": True,
    "read": {"enabled": True, "min_bytes": 60000, "lines": 600},
    "bash": {"enabled": True, "tail": 80, "commands": []},
}

# commands the harness never wraps: anything already shaping its own output,
# running in the background, writing files, or using heredocs
SKIP_BASH = re.compile(r"\|\s*(tail|head|grep|less|more|wc|jq|sed|awk)\b|(^|[^&])&\s*$|<<|>\s*[^&]|\bwatch\b|\bnohup\b")


def load_rules():
    try:
        r = json.loads(RULES.read_text(encoding="utf-8"))
        out = json.loads(json.dumps(DEFAULT_RULES))
        out["enabled"] = r.get("enabled", True)
        out["read"].update(r.get("read") or {})
        out["bash"].update(r.get("bash") or {})
        return out
    except (OSError, ValueError):
        return DEFAULT_RULES


def log(entry):
    try:
        HOME.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": time.time(), **entry}) + "\n")
    except OSError:
        pass


def command_key(cmd):
    """The part of a command that identifies it: program plus subcommand, ignoring a leading cd."""
    cmd = cmd.strip()
    cmd = re.sub(r"^cd\s+\S+\s*&&\s*", "", cmd)
    parts = cmd.split()
    return " ".join(parts[:2]) if parts else ""


def respond(new_input, note):
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": new_input}}
    if note:
        out["hookSpecificOutput"]["additionalContext"] = note
    sys.stdout.write(json.dumps(out))


def handle_read(inp, rules, ev):
    r = rules["read"]
    if not r.get("enabled") or inp.get("offset") or inp.get("limit") or inp.get("pages"):
        return
    path = inp.get("file_path") or ""
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    if size < int(r.get("min_bytes", 60000)):
        return
    if Path(path).suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".ipynb"):
        return
    lines = int(r.get("lines", 600))
    try:
        with open(path, "rb") as fh:
            total = sum(1 for _ in fh)
    except OSError:
        return
    if total <= lines:
        return
    new = dict(inp)
    new["limit"] = lines
    saved = max(0, size - size * lines / total) / CHARS_PER_TOKEN
    respond(new, f"Mallow: {Path(path).name} has {total:,} lines, so only lines 1-{lines} were read. "
                 f"Use offset and limit, or Grep, to see more.")
    log({"kind": "read", "session": ev.get("session_id"), "cwd": ev.get("cwd"), "target": path,
         "lines": total, "kept": lines, "saved": round(saved)})


def handle_bash(inp, rules, ev):
    b = rules["bash"]
    if not b.get("enabled") or inp.get("run_in_background"):
        return
    cmd = inp.get("command") or ""
    if not cmd.strip() or "\n" in cmd.strip() or SKIP_BASH.search(cmd):
        return
    key = command_key(cmd)
    match = next((c for c in b.get("commands", []) if c.get("enabled", True) and c.get("key") == key), None)
    if not match:
        return
    tail = int(match.get("tail") or b.get("tail", 80))
    new = dict(inp)
    # a subshell with pipefail keeps the real exit code, so Claude still sees failures
    new["command"] = f"( set -o pipefail; ( {cmd} ) 2>&1 | tail -n {tail} )"
    respond(new, f"Mallow: this command usually prints a lot, so only its last {tail} lines are shown.")
    log({"kind": "bash", "session": ev.get("session_id"), "cwd": ev.get("cwd"), "target": key,
         "kept": tail, "saved": max(0, round(match.get("avg_tokens", 0) - tail * 30))})


def main():
    try:
        ev = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return
    if ev.get("hook_event_name") != "PreToolUse":
        return
    rules = load_rules()
    if not rules.get("enabled", True):
        return
    tool, inp = ev.get("tool_name"), ev.get("tool_input") or {}
    if not isinstance(inp, dict):
        return
    if tool == "Read":
        handle_read(inp, rules, ev)
    elif tool == "Bash":
        handle_bash(inp, rules, ev)


if __name__ == "__main__":
    try:
        main()
    except Exception:          # never get in the way of a tool call
        pass
    sys.exit(0)
