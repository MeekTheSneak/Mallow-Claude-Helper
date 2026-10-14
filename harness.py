#!/usr/bin/env python3
"""
Mallow harness: a Claude Code PreToolUse hook that trims wasteful tool calls
before they run. It never contacts a model and never approves anything:
rewritten calls still go through your normal permission prompts.

What it does
  Read  of a very large file with no line range  -> reads the first N lines,
        and tells Claude in one line how to read more.
  Bash  build, test and install commands that printed huge logs before, in the
        same project -> Claude sees the lines that mention errors plus the last
        N lines. The full log is saved to a file Claude can open if it needs more,
        so it never has to run the command again to see it.

It only ever touches build, test and install style commands (npm test, cargo
build, gradlew, pytest and the like). Commands whose output is the point, like
cat, sed, grep, git diff or a script, are never trimmed.

Rules live in ~/.mallow/harness-rules.json (Mallow writes them from your
history; you can switch each one off in the app). Every change is logged to
~/.mallow/harness-log.jsonl so the app can show what it did.

Any error here exits quietly, so the tool call goes ahead untouched.
"""
import json
import os
import re
import shlex
import sys
import time
from pathlib import Path

HOME = Path.home() / ".mallow"
RULES = HOME / "harness-rules.json"
LOG = HOME / "harness-log.jsonl"
OUT = HOME / "out"
CHARS_PER_TOKEN = 4
KEEP_LOGS_SECONDS = 2 * 24 * 3600

DEFAULT_RULES = {
    "enabled": True,
    "read": {"enabled": True, "min_bytes": 60000, "lines": 600},
    "bash": {"enabled": True, "tail": 60, "commands": []},
}

# Commands that print logs, where the useful part is the errors and the end.
# program -> allowed first arguments (None means any).
RUNNERS = {
    "npm": {"test", "t", "ci", "install", "i", "run"}, "pnpm": {"test", "t", "install", "i", "run"},
    "yarn": {"test", "install", "run", "build"}, "bun": {"test", "install", "run"},
    "cargo": {"build", "test", "check", "clippy", "nextest", "bench"},
    "gradlew": None, "gradle": None, "mvn": None, "mvnw": None, "make": None, "ninja": None,
    "dotnet": {"build", "test", "restore", "publish"}, "msbuild": None,
    "go": {"build", "test", "vet"}, "cmake": {"--build"},
    "pytest": None, "tox": None, "nox": None, "jest": None, "vitest": None, "tsc": None,
    "eslint": None, "playwright": None,
    "pip": {"install"}, "pip3": {"install"},
    "flutter": {"build", "test", "pub"}, "rojo": {"build"},
    "docker": {"build", "compose"},
}
# for "npm run <script>" and friends: only scripts that build or check things
SCRIPT_OK = re.compile(r"build|test|lint|check|typecheck|compile|verify")
# never wrap these: they already shape their output, run in the background, write files, or use heredocs
SKIP_BASH = re.compile(r"\|\s*(tail|head|grep|less|more|wc|jq|sed|awk)\b|(^|[^&])&\s*$|<<|>\s*[^&]|\bwatch\b|\bnohup\b")
ERROR_WORDS = "error|fail|panic|exception|traceback|fatal"


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


def _split(segment):
    try:
        return shlex.split(segment.replace("\\", "/"), posix=True)   # Windows paths: keep the separators
    except ValueError:
        return segment.split()


def runner_key(cmd):
    """'npm test', 'cargo build', 'gradlew', 'pytest'... for a build/test/install command, else None.
    A leading 'cd somewhere &&' (or ';'), environment settings and 'timeout N' are ignored.
    Anything with a pipe, or more than one real command, is left alone."""
    cmd = (cmd or "").strip()
    if not cmd or "\n" in cmd or "|" in cmd or "`" in cmd or "$(" in cmd:
        return None
    parts = [p.strip() for p in re.split(r"&&|;", cmd) if p.strip()]
    real = []
    for p in parts:
        words = _split(p)
        while words and re.match(r"^\w+=", words[0]):          # FOO=1 npm test
            words = words[1:]
        if words and words[0] not in ("cd", "pushd", "export", "set"):
            real.append(words)
    if len(real) != 1:
        return None
    words = real[0]
    if words[:1] == ["timeout"] and len(words) > 2:
        words = words[2:]
    if not words:
        return None
    prog = re.split(r"[\\/]", words[0])[-1].lower()
    prog = re.sub(r"\.(exe|bat|cmd)$", "", prog)
    args = words[1:]
    if prog in ("python", "python3", "py") and args[:2] == ["-m", "pytest"]:
        return "pytest"
    if prog in ("python", "python3", "py") and args[:1] == ["-m"] and args[1:2] == ["pip"] and "install" in args:
        return "pip install"
    if prog == "uv" and args[:1] == ["run"] and len(args) > 1:
        return runner_key(" ".join(args[1:]))
    if prog == "uv" and args[:1] in (["sync"], ["pip"]):
        return "uv " + args[0]
    if prog == "npx" and args:
        return runner_key(" ".join(args))
    if prog not in RUNNERS:
        return None
    allowed = RUNNERS[prog]
    if allowed is None:
        return prog
    sub = args[0] if args else ""
    if sub not in allowed:
        return None
    if sub == "run":
        script = args[1] if len(args) > 1 else ""
        return f"{prog} run {script}" if SCRIPT_OK.search(script) else None
    return f"{prog} {sub}"


def _norm(path):
    return str(path or "").replace("\\", "/").rstrip("/").lower()


def in_projects(cwd, projects):
    """True when cwd is one of the rule's project folders or inside one. A rule with no projects applies anywhere."""
    if not projects:
        return True
    c = _norm(cwd)
    return any(c == _norm(p) or c.startswith(_norm(p) + "/") for p in projects)


def match_rule(cmd, cwd, rules):
    """The enabled Bash rule that applies to this command in this folder, or None."""
    b = rules["bash"]
    if not b.get("enabled") or not cmd or SKIP_BASH.search(cmd):
        return None
    key = runner_key(cmd)
    if not key:
        return None
    return next((c for c in b.get("commands", [])
                 if c.get("enabled", True) and c.get("key") == key and in_projects(cwd, c.get("projects"))), None)


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


def _old_logs_cleanup():
    try:
        cutoff = time.time() - KEEP_LOGS_SECONDS
        for f in OUT.glob("*.log"):
            if f.stat().st_mtime < cutoff:
                f.unlink()
    except OSError:
        pass


def wrap_command(cmd, tail, logfile):
    """The command, run as before, with its full output saved to logfile and a short version shown:
    lines mentioning errors (up to 40) that fall before the tail, then the last `tail` lines.
    pipefail keeps the command's own exit code, so Claude still sees failures."""
    lf = str(logfile).replace("\\", "/")
    prog = ("{b[NR%T]=$0} n<40 && tolower($0) ~ /" + ERROR_WORDS + "/ {m[++n]=NR; t[n]=$0} "
            "END{s=1; if(NR>T){c=0; for(i=1;i<=n;i++) if(m[i]<=NR-T){if(!c){print \"[Mallow: earlier lines that mention errors]\"; c=1} print m[i] \": \" t[i]} "
            "print \"[Mallow: last \" T \" of \" NR \" lines. Full output: " + lf + "]\"; s=NR-T+1} for(i=s;i<=NR;i++) print b[i%T]}")
    return f"( set -o pipefail; ( {cmd} ) 2>&1 | tee {shlex.quote(lf)} | awk -v T={int(tail)} {shlex.quote(prog)} )"


def handle_bash(inp, rules, ev):
    if inp.get("run_in_background"):
        return
    cmd = (inp.get("command") or "").strip()
    rule = match_rule(cmd, ev.get("cwd"), rules)
    if not rule:
        return
    tail = int(rule.get("tail") or rules["bash"].get("tail", 60))
    try:
        OUT.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    _old_logs_cleanup()
    logfile = OUT / f"{int(time.time() * 1000)}-{re.sub(r'[^a-z0-9]+', '-', rule['key'].lower())}.log"
    new = dict(inp)
    new["command"] = wrap_command(cmd, tail, logfile)
    respond(new, f"Mallow: {rule['key']} usually prints a long log, so you'll see the lines that mention errors "
                 f"and the last {tail} lines. If you need the rest, Read {str(logfile).replace(chr(92), '/')} "
                 f"instead of running it again.")
    log({"kind": "bash", "session": ev.get("session_id"), "cwd": ev.get("cwd"), "target": rule["key"],
         "kept": tail, "file": str(logfile), "saved": max(0, round(rule.get("avg_tokens", 0) - tail * 30))})


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
