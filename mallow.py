#!/usr/bin/env python3
"""
Mallow
A live, local companion for Claude Code, looked after by Mallow the hamster.

Run it and a page opens in your browser. Mallow watches the session files
Claude Code writes on this computer (~/.claude/projects) and reacts as you
work: he runs his wheel (or fights a dragon) while Claude works, baby hamsters
join for each subagent or parallel thread, he waves when it's your turn, and
he holds up a sign when something wasteful happens, until you acknowledge it.

Below the room is a report of past sessions and an "Export for Claude" brief.

Everything stays on this computer. The page is served only to 127.0.0.1, and
Mallow never contacts Claude or anything else. Python 3.9+, standard library.

    python mallow.py              # start and open the page
    python mallow.py --no-open    # start without opening a browser
"""

import argparse
import hashlib
import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = Path(getattr(sys, "_MEIPASS", HERE)) / "web"   # also works when bundled into an app
STATE_DIR = Path.home() / ".mallow"
STATE_FILE = STATE_DIR / "state.json"
DEFAULT_PORT = 47321
VERSION = 5                      # bumped on each release; a newer Mallow asks an older running one to step aside
IDLE_EXIT_SECONDS = 180          # quit when no page has asked for anything for this long
LIVE_WINDOW_SECONDS = 6 * 3600   # files touched this recently are watched live

# ---------------------------------------------------------------------------
# Weights for "usage units". 1 unit = 1 uncached input token on a Haiku-class
# model. These compare sessions with each other; they are not a bill.
# ---------------------------------------------------------------------------
WEIGHTS = {"input": 1.0, "cache_write_5m": 1.25, "cache_write_1h": 2.0, "cache_read": 0.1, "output": 5.0}
MODEL_MULT = [("haiku", 1.0), ("sonnet", 3.0), ("opus", 5.0)]
DEFAULT_MULT = 5.0
COLD_WRITE_MIN = 20_000
BIG_RESULT_TOKENS = 5_000
LIVE_BIG_RESULT_TOKENS = 20_000
HEAVY_BASELINE = 30_000
CHARS_PER_TOKEN = 4
AGENT_TOOLS = ("Task", "Agent")
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")


def model_mult(model):
    m = (model or "").lower()
    for key, mult in MODEL_MULT:
        if key in m:
            return mult
    return DEFAULT_MULT


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def text_lines(content):
    if isinstance(content, str):
        return content.count("\n") + 1
    n = 0
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                n += block.get("text", "").count("\n") + 1
    return n


def text_len(content):
    if isinstance(content, str):
        return len(content)
    total = 0
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    total += len(block.get("text", ""))
                elif block.get("type") == "image":
                    total += 6_000
    return total


def tool_target(inp):
    if not isinstance(inp, dict):
        return ""
    for key in ("file_path", "notebook_path", "command", "url", "pattern", "query", "path", "description", "prompt"):
        if inp.get(key):
            return str(inp[key]).replace("\n", " ")[:140]
    return ""


def short_path(p):
    p = p.replace("\\", "/")
    parts = [x for x in p.split("/") if x]
    return "/".join(parts[-2:]) if len(parts) > 1 else (parts[0] if parts else p)


def activity_for(name, inp):
    """A short label and a category for what a tool call is doing."""
    inp = inp if isinstance(inp, dict) else {}
    if name in EDIT_TOOLS:
        return "edit", f"edit {short_path(inp.get('file_path') or inp.get('notebook_path') or '')}".strip()
    if name == "Bash":
        cmd = (inp.get("command") or "").strip().splitlines()[0] if inp.get("command") else ""
        return "bash", f"run {cmd[:48]}".strip()
    if name in ("Read",):
        return "read", f"read {short_path(inp.get('file_path') or '')}".strip()
    if name in ("Grep", "Glob", "LS"):
        return "read", f"search {str(inp.get('pattern') or inp.get('path') or '')[:40]}".strip()
    if name in ("WebFetch",):
        url = str(inp.get("url") or "")
        host = url.split("//")[-1].split("/")[0]
        return "web", f"fetch {host}".strip()
    if name in ("WebSearch",):
        return "web", f"search the web for {str(inp.get('query') or '')[:36]}".strip()
    if name in AGENT_TOOLS:
        return "agent", f"start {inp.get('subagent_type') or 'a'} agent"
    if name.startswith("mcp__"):
        bits = name.split("__")
        server = bits[1] if len(bits) > 1 else "tool"
        tool = bits[2] if len(bits) > 2 else ""
        return "web", f"call {server} · {tool.replace('_', ' ')}".strip()
    if name in ("TodoWrite", "TaskCreate", "TaskUpdate"):
        return "plan", "update the to-do list"
    return "other", name


def pretty_model(m):
    """claude-opus-5-5 -> Opus 5.5"""
    import re
    m = (m or "").replace("claude-", "")
    m = re.sub(r"(\d+)-(\d+)", r"\1.\2", m)
    return " ".join(w.capitalize() if w.isalpha() else w for w in m.split("-"))


def role_for(agent_type):
    t = (agent_type or "").lower()
    if "secur" in t:
        return "security"
    if any(k in t for k in ("review", "verif", "audit", "lint")):
        return "review"
    if "test" in t:
        return "test"
    if any(k in t for k in ("explore", "search", "research")):
        return "explore"
    if any(k in t for k in ("plan", "architect", "design")):
        return "plan"
    if any(k in t for k in ("guide", "doc")):
        return "docs"
    if any(k in t for k in ("general", "code", "dev", "engineer")):
        return "dev"
    return "worker"


# ===========================================================================
# History report (all sessions)
# ===========================================================================
class Session:
    def __init__(self, sid):
        self.sid = sid
        self.cwd = None
        self.branch = None
        self.title = None
        self.summary = None
        self.calls = []
        self.tools = {}
        self.results = []
        self.tinfo = {}            # tool_use_id -> {ranged, cmd}
        self.rmeta = {}            # tool_use_id -> {lines, err}
        self.reads = Counter()
        self.tool_counts = Counter()
        self.compactions = []
        self.prompts = 0
        self.first_ts = None
        self.last_ts = None

    def touch(self, ts):
        if ts is None:
            return
        if self.first_ts is None or ts < self.first_ts:
            self.first_ts = ts
        if self.last_ts is None or ts > self.last_ts:
            self.last_ts = ts


def is_prompt_text(t):
    return bool(t) and not t.startswith("<") and not t.startswith("[Request interrupted")


def parse_file(path):
    """One transcript file into Session pieces keyed by session id. A session can span several files
    (its subagents, or a resumed copy), so pieces are merged later and duplicate calls dropped there."""
    sessions = {}
    seen_msgs = set()
    is_sub_file = "subagents" in path.parts
    try:
        fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return sessions
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(rec, dict):
                continue
            sid = rec.get("sessionId") or path.stem
            s = sessions.get(sid)
            if s is None:
                s = sessions[sid] = Session(sid)
            ts = parse_ts(rec.get("timestamp"))
            s.touch(ts)
            if rec.get("cwd") and not s.cwd:
                s.cwd = rec["cwd"]
            if rec.get("gitBranch") and not s.branch:
                s.branch = rec["gitBranch"]
            sub = is_sub_file or bool(rec.get("isSidechain"))
            rtype = rec.get("type")
            if rtype == "summary" and rec.get("summary"):
                s.summary = rec["summary"]
                continue
            if rec.get("isCompactSummary") or (rtype == "system" and rec.get("subtype") == "compact_boundary"):
                if ts:
                    s.compactions.append(ts)
                continue
            msg = rec.get("message")
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            if rtype == "assistant":
                key = (msg.get("id"), rec.get("requestId"))
                usage = msg.get("usage") or {}
                if key not in seen_msgs and usage and key != (None, None):
                    seen_msgs.add(key)
                    cc = usage.get("cache_creation") or {}
                    cw_total = usage.get("cache_creation_input_tokens", 0) or 0
                    cw1h = cc.get("ephemeral_1h_input_tokens", 0) or 0
                    cw5 = cc.get("ephemeral_5m_input_tokens", cw_total - cw1h) or 0
                    s.calls.append({
                        "key": key, "ts": ts, "model": msg.get("model") or "unknown",
                        "in": usage.get("input_tokens", 0) or 0, "cw5": cw5, "cw1h": cw1h,
                        "cr": usage.get("cache_read_input_tokens", 0) or 0,
                        "out": usage.get("output_tokens", 0) or 0, "sub": sub,
                    })
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            name = b.get("name", "?")
                            inp = b.get("input") or {}
                            s.tools[b.get("id")] = (name, tool_target(inp), sub)
                            if isinstance(inp, dict):
                                s.tinfo[b.get("id")] = {"ranged": bool(inp.get("offset") or inp.get("limit")), "cmd": str(inp.get("command") or "")[:300],
                                                          "bg": bool(inp.get("run_in_background"))}
                            s.tool_counts[name] += 1
                            if name == "Read" and not sub and isinstance(inp, dict) and inp.get("file_path"):
                                s.reads[inp["file_path"]] += 1
            elif rtype == "user":
                if isinstance(content, str):
                    if not rec.get("isMeta") and not sub and is_prompt_text(content.strip()):
                        s.prompts += 1
                        if not s.title:
                            s.title = content.strip().splitlines()[0][:90]
                elif isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict):
                            continue
                        if b.get("type") == "tool_result":
                            s.results.append((b.get("tool_use_id"), text_len(b.get("content")), ts, sub))
                            s.rmeta[b.get("tool_use_id")] = {"lines": text_lines(b.get("content")), "err": bool(b.get("is_error"))}
                        elif b.get("type") == "text" and not sub and not rec.get("isMeta"):
                            t = b.get("text", "").strip()
                            if is_prompt_text(t):
                                s.prompts += 1
                                if not s.title:
                                    s.title = t.splitlines()[0][:90]
    return sessions


def merge_pieces(sid, pieces):
    """Join the pieces of one session from several files, counting each model call once."""
    out = Session(sid)
    seen = set()
    for pc in pieces:
        for ts in (pc.first_ts, pc.last_ts):
            out.touch(ts)
        out.cwd = out.cwd or pc.cwd
        out.branch = out.branch or pc.branch
        out.title = out.title or pc.title
        out.summary = pc.summary or out.summary
        for c in pc.calls:
            if c["key"] in seen:
                continue
            seen.add(c["key"])
            out.calls.append(c)
        out.tools.update(pc.tools)
        out.tinfo.update(pc.tinfo)
        out.rmeta.update(pc.rmeta)
        out.results.extend(pc.results)
        out.reads.update(pc.reads)
        out.tool_counts.update(pc.tool_counts)
        out.compactions.extend(pc.compactions)
        out.prompts += pc.prompts
    return out


def load_sessions(root):
    """Every session under root (used by tests and one-off reports; the app uses ReportCache)."""
    pieces = defaultdict(list)
    for path in sorted(root.rglob("*.jsonl")):
        for sid, pc in parse_file(path).items():
            pieces[sid].append(pc)
    return {sid: merge_pieces(sid, pcs) for sid, pcs in pieces.items()}


def call_cost(c):
    return model_mult(c["model"]) * (
        c["in"] * WEIGHTS["input"] + c["cw5"] * WEIGHTS["cache_write_5m"]
        + c["cw1h"] * WEIGHTS["cache_write_1h"] + c["cr"] * WEIGHTS["cache_read"]
        + c["out"] * WEIGHTS["output"])


def ctx(c):
    return c["in"] + c["cw5"] + c["cw1h"] + c["cr"]


def mood_for(hit, waste_ratio):
    if waste_ratio > 0.25:
        return "stuffed"
    if hit < 0.7 or waste_ratio > 0.10:
        return "worried"
    if hit >= 0.85 and waste_ratio < 0.05:
        return "happy"
    return "okay"


def analyze(s):
    calls = sorted([c for c in s.calls if c["ts"]], key=lambda c: c["ts"])
    main = [c for c in calls if not c["sub"]]
    subs = [c for c in calls if c["sub"]]
    f = []
    tot = defaultdict(float)
    for c in calls:
        for k in ("in", "cw5", "cw1h", "cr", "out"):
            tot[k] += c[k]
    cost = sum(call_cost(c) for c in calls)
    sub_cost = sum(call_cost(c) for c in subs)
    denom = tot["in"] + tot["cw5"] + tot["cw1h"] + tot["cr"]
    hit = (tot["cr"] / denom) if denom else 0.0
    baseline = ctx(main[0]) if main else 0
    mix = Counter()
    for c in calls:
        mix[c["model"]] += call_cost(c)

    for prev, cur in zip(main, main[1:]):
        gap = (cur["ts"] - prev["ts"]).total_seconds() / 60
        written = cur["cw5"] + cur["cw1h"]
        ttl = 60 if cur["cw1h"] > cur["cw5"] else 5
        if written >= COLD_WRITE_MIN and gap > ttl:
            m = model_mult(cur["model"])
            wasted = m * (cur["cw5"] * (WEIGHTS["cache_write_5m"] - WEIGHTS["cache_read"])
                          + cur["cw1h"] * (WEIGHTS["cache_write_1h"] - WEIGHTS["cache_read"]))
            f.append({
                "kind": "Cold cache", "who": "you", "units": wasted,
                "detail": f"A {int(gap)} minute break, then {written:,} tokens had to be cached again",
                "fix": f"The cache expires after about {ttl} minutes, so the next message re-sent the whole conversation at full price. "
                       "Come back sooner, or start a new session with a short handoff note.",
            })

    compact_times = sorted(s.compactions)
    main_times = [c["ts"] for c in main]
    main_mult = model_mult(main[0]["model"]) if main else DEFAULT_MULT
    for tid, chars, ts, sub in s.results:
        toks = chars // CHARS_PER_TOKEN
        if toks < BIG_RESULT_TOKENS or ts is None:
            continue
        name, target, _ = s.tools.get(tid, ("?", "", sub))
        label = f"{name} {target}".strip()
        if sub:
            f.append({
                "kind": "Big tool result", "who": "info", "units": 0, "tool": name, "target": target, "toks": toks,
                "detail": f"{label} returned about {toks:,} tokens inside a subagent",
                "fix": "This stayed inside the subagent, so it didn't weigh down the main conversation.",
            })
            continue
        stop = next((t for t in compact_times if t > ts), None)
        later = sum(1 for t in main_times if t > ts and (stop is None or t < stop))
        carried = toks * later * WEIGHTS["cache_read"] * main_mult + toks * WEIGHTS["cache_write_5m"] * main_mult
        f.append({
            "kind": "Big tool result", "who": "claude", "units": carried, "tool": name, "target": target, "toks": toks,
            "detail": f"{label} returned about {toks:,} tokens, re-sent on {later} later turn{'s' if later != 1 else ''}",
            "fix": {"Read": "Reading it by line range would have pulled in a fraction of this.",
                    "Bash": "Piping the output through tail or grep, or using a quieter flag, keeps this small."}.get(
                name, "A narrower request, like a tighter pattern or a result limit, would bring back less."),
        })

    for path, n in s.reads.most_common():
        if n < 3:
            break
        f.append({
            "kind": "Re-read file", "who": "claude", "units": 0, "tool": "Read", "target": path, "count": n,
            "detail": f"{path} was read {n} times",
            "fix": "A short outline of this file in CLAUDE.md usually stops the re-reading.",
        })
    if baseline >= HEAVY_BASELINE:
        f.append({
            "kind": "Heavy start", "who": "claude", "units": 0,
            "detail": f"The first message already carried {baseline:,} tokens",
            "fix": "Trim CLAUDE.md and turn off MCP servers or plugins this project doesn't use. This load rides along on every turn.",
        })
    if len(s.compactions) >= 2:
        f.append({
            "kind": "Long session", "who": "you", "units": 0,
            "detail": f"Context was compacted {len(s.compactions)} times",
            "fix": "Each compaction drops detail. Shorter sessions with a handoff note usually cost less.",
        })
    if cost and sub_cost / cost > 0.5 and len(subs) > 10:
        f.append({
            "kind": "Subagent heavy", "who": "claude", "units": 0,
            "detail": f"Subagents used {sub_cost / cost:.0%} of this session's usage",
            "fix": "Each subagent starts from scratch, so they're best saved for searches across many files.",
        })

    f.sort(key=lambda x: -x["units"])
    waste = sum(x["units"] for x in f)
    dur = int((s.last_ts - s.first_ts).total_seconds() // 60) if s.first_ts and s.last_ts else 0
    return {
        "id": s.sid, "project": s.cwd or "(unknown folder)", "branch": s.branch or "",
        "title": s.summary or s.title or f"Session {s.sid[:8]}",
        "start": s.first_ts.isoformat() if s.first_ts else None,
        "end": s.last_ts.isoformat() if s.last_ts else None,
        "minutes": dur, "cost": round(cost), "waste": round(waste), "hit": round(hit, 4),
        "mood": mood_for(hit, waste / cost if cost else 0),
        "tok": {k: int(v) for k, v in tot.items()}, "den": int(denom),
        "peak": max((ctx(c) for c in main), default=0), "baseline": baseline,
        "prompts": s.prompts, "calls": len(calls), "subCalls": len(subs),
        "subShare": round(sub_cost / cost, 3) if cost else 0, "compactions": len(s.compactions),
        "models": [[m.replace("claude-", ""), round(u / cost, 3) if cost else 0] for m, u in mix.most_common()],
        "tools": s.tool_counts.most_common(6),
        "findings": [{**x, "units": round(x["units"])} for x in f],
    }


class ReportCache:
    """The history report, kept up to date cheaply: each file is parsed once and again only when it changes,
    and only the sessions those files belong to are rebuilt. Old sessions keep their summary but drop the
    per-call detail, which is only needed for the replay of recent sessions."""
    DETAIL_DAYS = 30

    def __init__(self, root):
        self.root = root
        self.lock = threading.Lock()
        self.files = {}          # path -> {"key": (size, mtime), "sids": set}
        self.pieces = {}         # sid -> {path: Session piece}
        self.analyzed = {}       # sid -> analyze() result
        self.merged = {}         # sid -> merged Session (recent sessions only)
        self.data = None
        self.raw = []
        self.built = 0

    def get(self):
        with self.lock:
            now = time.time()
            if self.data is not None and now - self.built < 60:
                return self.data
            self.built = now
            changed = set()
            seen_paths = set()
            if self.root.exists():
                for dirpath, _dirs, names in os.walk(self.root):
                    for fn in names:
                        if not fn.endswith(".jsonl"):
                            continue
                        path = os.path.join(dirpath, fn)
                        try:
                            st = os.stat(path)
                        except OSError:
                            continue
                        seen_paths.add(path)
                        key = (st.st_size, st.st_mtime)
                        old = self.files.get(path)
                        if old and old["key"] == key:
                            continue
                        for sid in (old or {}).get("sids", ()):
                            self.pieces.get(sid, {}).pop(path, None)
                            changed.add(sid)
                        parsed = parse_file(Path(path))
                        for sid, pc in parsed.items():
                            self.pieces.setdefault(sid, {})[path] = pc
                            changed.add(sid)
                        self.files[path] = {"key": key, "sids": set(parsed)}
            for path in [p for p in self.files if p not in seen_paths]:     # deleted files
                for sid in self.files.pop(path)["sids"]:
                    self.pieces.get(sid, {}).pop(path, None)
                    changed.add(sid)
            if self.data is not None and not changed:
                return self.data
            cutoff = now - self.DETAIL_DAYS * 86400
            for sid in changed:
                pcs = self.pieces.get(sid) or {}
                for path, pc in list(pcs.items()):      # a slimmed-down old piece needs its detail back
                    if getattr(pc, "light", False):
                        fresh = parse_file(Path(path)).get(sid)
                        if fresh:
                            pcs[path] = fresh
                if not pcs:
                    self.pieces.pop(sid, None); self.analyzed.pop(sid, None); self.merged.pop(sid, None)
                    continue
                m = merge_pieces(sid, [pcs[p] for p in sorted(pcs)])
                if not m.calls:
                    self.analyzed.pop(sid, None); self.merged.pop(sid, None)
                    continue
                self.analyzed[sid] = analyze(m)
                if m.last_ts and m.last_ts.timestamp() >= cutoff:
                    self.merged[sid] = m
                else:                                   # old session: keep the summary, drop the detail
                    self.merged.pop(sid, None)
                    for pc in pcs.values():
                        pc.results, pc.tools, pc.tinfo, pc.rmeta = [], {}, {}, {}
                        pc.light = True
            self.raw = list(self.merged.values())
            self.data = {"generated": datetime.now(timezone.utc).isoformat(), "root": str(self.root),
                         "sessions": [a for a in self.analyzed.values() if a["end"]]}
            return self.data


# ===========================================================================
# Live watcher
# ===========================================================================
class LiveFile:
    """Incrementally reads one transcript file and keeps its live state."""

    def __init__(self, path, is_sub, parent_sid):
        self.path = path
        self.is_sub = is_sub
        self.parent_sid = parent_sid
        self.offset = 0
        self.partial = b""
        self.mtime = 0.0
        self.sid = None
        self.cwd = None
        self.branch = None
        self.title = None
        self.summary = None
        self.pending = {}            # tool_use_id -> info
        self.last_kind = None        # prompt | tool_result | assistant_tool | assistant_text | assistant_end | interrupted
        self.last_ts = None
        self.first_ts = None
        self.turn_start = None
        self.last_call = None
        self.seen = set()
        self.ttl_1h = False
        self.journal = Counter()
        self.files = set()
        self.bash_failing = False
        self.reads = Counter()
        self.recent = []             # (tool, label, failed) for the last few tool results in the main thread
        self.launches = []           # (ts, type, description) for Agent tool calls
        self.ended_at = None
        self.last_status = None

    # -- helpers --
    def active_at(self):
        """When the session last really did something. Claude Code sometimes touches old
        files (adding summaries), so the file's modified time alone can make a stale session look live."""
        return self.last_ts.timestamp() if self.last_ts else self.mtime

    def status(self, now):
        idle_for = now - self.active_at()
        if self.last_kind in ("assistant_end", "interrupted"):
            return "your_turn" if idle_for < 120 else "idle"
        if self.pending:
            return "working" if idle_for < 900 else "idle"
        if self.last_kind in ("prompt", "tool_result"):
            return "thinking" if idle_for < 600 else "idle"
        if self.last_kind == "assistant_text":
            if idle_for < 6:
                return "thinking"
            return "your_turn" if idle_for < 120 else "idle"
        if self.last_kind == "assistant_tool":
            return "working" if idle_for < 900 else "idle"
        return "idle"

    def current_activity(self):
        if not self.pending:
            return None
        tools = [i for i in self.pending.values() if i["name"] not in AGENT_TOOLS]
        if tools:
            info = max(tools, key=lambda i: i["seq"])
            return {"kind": info["kind"], "label": info["label"], "tool": info["name"]}
        n = len(self.pending)
        return {"kind": "agent", "label": f"working with {n} helper{'s' if n != 1 else ''}", "tool": "Agent"}


class Watcher:
    def __init__(self, root):
        self.root = root
        self.start = time.time()
        self.lock = threading.Lock()
        self.files = {}              # path -> LiveFile
        self.events = []             # recent transient events
        self.seq = 0
        self.tool_seq = 0
        self.incidents = []          # unacknowledged incidents
        self.acked = set()
        self.last_request = time.time()
        self._load_state()

    # -- persisted incidents --
    def _load_state(self):
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            self.incidents = [i for i in data.get("incidents", []) if isinstance(i, dict) and i.get("id")]
            self.acked = set(data.get("acked", []))
        except (OSError, ValueError):
            pass

    def _save_state(self):
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            tmp = STATE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps({"incidents": self.incidents[-50:], "acked": sorted(self.acked)[-500:]}), encoding="utf-8")
            tmp.replace(STATE_FILE)
        except OSError:
            pass

    def ack(self, iid):
        with self.lock:
            if iid == "*":
                self.acked.update(i["id"] for i in self.incidents)
                self.incidents = []
            else:
                self.acked.add(iid)
                self.incidents = [i for i in self.incidents if i["id"] != iid]
            self._save_state()

    # -- events --
    def emit(self, lf, rec_ts, etype, **data):
        if rec_ts is None or rec_ts.timestamp() < self.start - 2:
            return          # only react to things that happen while Mallow is open
        self.seq += 1
        ev = {"seq": self.seq, "type": etype, "session": lf.parent_sid or lf.sid, "sub": lf.is_sub, **data}
        self.events.append(ev)
        if len(self.events) > 200:
            self.events = self.events[-200:]

    def incident(self, lf, rec_ts, kind, title, detail):
        if rec_ts is None or rec_ts.timestamp() < self.start - 2:
            return
        iid = hashlib.sha1(f"{lf.sid}|{kind}|{rec_ts.isoformat()}|{detail}".encode()).hexdigest()[:12]
        if iid in self.acked or any(i["id"] == iid or (i["kind"] == kind and i["detail"] == detail) for i in self.incidents):
            return
        self.incidents.append({"id": iid, "kind": kind, "title": title, "detail": detail,
                               "session": lf.title or lf.summary or (lf.sid or "")[:8],
                               "at": rec_ts.isoformat()})
        self._save_state()
        self.emit(lf, rec_ts, "incident", kind=kind)

    # -- scanning --
    FULL_SCAN_EVERY = 15        # seconds between walks of the whole folder; known live files are checked every second
    FIRST_READ_MAX = 32 << 20   # a long transcript opened for the first time: only its last 32 MB matter for live state

    def scan(self):
        now = time.time()
        if not self.root.exists():
            return
        if now - getattr(self, "_walked", 0) >= self.FULL_SCAN_EVERY:
            self._walked = now
            found = []
            for dirpath, _dirs, filenames in os.walk(self.root):
                for fn in filenames:
                    if fn.endswith(".jsonl"):
                        found.append(os.path.join(dirpath, fn))
            paths = found
            with self.lock:                             # forget files that went quiet long ago
                for p, lf in list(self.files.items()):
                    if now - lf.mtime > LIVE_WINDOW_SECONDS and lf.status(now) == "idle":
                        del self.files[p]
        else:
            with self.lock:
                paths = set(self.files)
                live = [lf for lf in self.files.values() if now - lf.mtime < 3600]
            # new sessions and new subagents usually appear next to files that are already live
            dirs = set()
            for lf in live:
                d = os.path.dirname(lf.path)
                dirs.add(d)
                if not lf.is_sub:
                    dirs.add(os.path.join(d, Path(lf.path).stem, "subagents"))
            for d in dirs:
                try:
                    with os.scandir(d) as it:
                        paths.update(e.path for e in it if e.name.endswith(".jsonl"))
                except OSError:
                    continue
        for p in paths:
            try:
                st = os.stat(p)
            except OSError:
                continue
            if now - st.st_mtime > LIVE_WINDOW_SECONDS:
                continue
            lf = self.files.get(p)
            if lf is None:
                parts = Path(p).parts
                is_sub = "subagents" in parts
                parent = Path(p).parent.parent.name if is_sub else None
                lf = LiveFile(p, is_sub, parent)
                if st.st_size > self.FIRST_READ_MAX:
                    lf.offset = st.st_size - self.FIRST_READ_MAX
                    lf.skip_partial = True
                with self.lock:
                    self.files[p] = lf
            if st.st_size < lf.offset:          # file was rewritten
                lf.offset, lf.partial = 0, b""
            if st.st_size > lf.offset:
                self._read(lf)
            lf.mtime = st.st_mtime
        # turn-end detection for files that went quiet after a text reply
        with self.lock:
            for lf in self.files.values():
                st = lf.status(now)
                if lf.last_status in ("working", "thinking") and st == "your_turn" and not lf.is_sub:
                    secs = int((lf.last_ts.timestamp() if lf.last_ts else now) - (lf.turn_start.timestamp() if lf.turn_start else now))
                    lf.journal["turns"] += 1
                    self.emit(lf, lf.last_ts or datetime.now(timezone.utc), "turn_end", secs=max(0, secs))
                lf.last_status = st

    def _read(self, lf):
        try:
            with open(lf.path, "rb") as fh:
                fh.seek(lf.offset)
                chunk = fh.read()
                lf.offset = fh.tell()
        except OSError:
            return
        data = lf.partial + chunk
        lines = data.split(b"\n")
        lf.partial = lines.pop()
        if getattr(lf, "skip_partial", False):      # started mid-file: the first line is a fragment
            lf.skip_partial = False
            lines = lines[1:]
        with self.lock:
            for raw in lines:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw.decode("utf-8", errors="replace"))
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    self._process(lf, rec)

    def _process(self, lf, rec):
        ts = parse_ts(rec.get("timestamp"))
        if ts:
            lf.last_ts = ts
            lf.first_ts = lf.first_ts or ts
        lf.sid = lf.sid or rec.get("sessionId")
        lf.cwd = lf.cwd or rec.get("cwd")
        lf.branch = lf.branch or rec.get("gitBranch")
        rtype = rec.get("type")
        if rtype == "summary" and rec.get("summary"):
            lf.summary = rec["summary"]
            return
        if rec.get("isCompactSummary") or (rtype == "system" and rec.get("subtype") == "compact_boundary"):
            if not lf.is_sub:
                self.incident(lf, ts, "compacted", "Context got compacted",
                              "The conversation filled up and was summarized, so some detail was lost. A fresh session with a handoff note often works better.")
            return
        msg = rec.get("message")
        if not isinstance(msg, dict):
            return
        content = msg.get("content")
        side = lf.is_sub or bool(rec.get("isSidechain"))

        if rtype == "user":
            if isinstance(content, str):
                t = content.strip()
                if t.startswith("[Request interrupted"):
                    lf.pending.clear()
                    lf.last_kind = "interrupted"
                elif not rec.get("isMeta") and is_prompt_text(t):
                    lf.title = lf.title or t.splitlines()[0][:90]
                    if not side:
                        lf.turn_start = ts
                        self.emit(lf, ts, "prompt")
                    lf.last_kind = "prompt"
                return
            if not isinstance(content, list):
                return
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text":
                    t = (b.get("text") or "").strip()
                    if t.startswith("[Request interrupted"):
                        lf.pending.clear()
                        lf.last_kind = "interrupted"
                    elif not rec.get("isMeta") and is_prompt_text(t):
                        lf.title = lf.title or t.splitlines()[0][:90]
                        if not side:
                            lf.turn_start = ts
                            self.emit(lf, ts, "prompt")
                        lf.last_kind = "prompt"
                elif b.get("type") == "tool_result":
                    info = lf.pending.pop(b.get("tool_use_id"), None)
                    lf.last_kind = "tool_result"
                    if not info:
                        continue
                    err = bool(b.get("is_error"))
                    name = info["name"]
                    toks = text_len(b.get("content")) // CHARS_PER_TOKEN
                    if name == "Bash":
                        lf.journal["commands"] += 1
                        if err:
                            if not lf.bash_failing:
                                self.emit(lf, ts, "bug", label=info["label"])
                            lf.bash_failing = True
                        elif lf.bash_failing:
                            lf.bash_failing = False
                            lf.journal["fixes"] += 1
                            self.emit(lf, ts, "squash")
                    elif name in EDIT_TOOLS:
                        lf.journal["edits"] += 1
                        if info.get("target"):
                            lf.files.add(info["target"])
                        self.emit(lf, ts, "edit_fail" if err else "edit_ok")
                    elif name == "Read" and not side:
                        tgt = info.get("target") or ""
                        lf.reads[tgt] += 1
                        if lf.reads[tgt] == 3:
                            self.incident(lf, ts, "reread", "Same file, third read",
                                          f"{short_path(tgt)} has now been read 3 times this session. An outline of it in CLAUDE.md usually stops this.")
                    if not side:
                        self._stuck_check(lf, ts, name, info["label"], err)
                    if not side and toks >= LIVE_BIG_RESULT_TOKENS:
                        self.incident(lf, ts, "big_result", "A huge tool result",
                                      f"{info['label']} returned about {toks:,} tokens. It now rides along on every later turn.")
            return

        if rtype == "assistant":
            usage = msg.get("usage") or {}
            key = (msg.get("id"), rec.get("requestId"))
            if usage and key != (None, None) and key not in lf.seen:
                lf.seen.add(key)
                cc = usage.get("cache_creation") or {}
                cw_total = usage.get("cache_creation_input_tokens", 0) or 0
                cw1h = cc.get("ephemeral_1h_input_tokens", 0) or 0
                cw5 = cc.get("ephemeral_5m_input_tokens", cw_total - cw1h) or 0
                if cw1h:
                    lf.ttl_1h = True
                call = {"ts": ts, "model": msg.get("model") or "", "in": usage.get("input_tokens", 0) or 0,
                        "cw": cw5 + cw1h, "cr": usage.get("cache_read_input_tokens", 0) or 0}
                prev = lf.last_call
                if prev and prev["ts"] and ts and not side:
                    gap = (ts - prev["ts"]).total_seconds()
                    ttl = 3600 if lf.ttl_1h else 300
                    if call["cw"] >= COLD_WRITE_MIN and gap > ttl:
                        self.incident(lf, ts, "cold_cache", "The cache went cold",
                                      f"After a {int(gap // 60)} minute break, {call['cw']:,} tokens had to be cached again at full price.")
                if not side or lf.is_sub:
                    lf.last_call = call
            had_tool = False
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        had_tool = True
                        name = b.get("name", "?")
                        inp = b.get("input") or {}
                        kind, label = activity_for(name, inp)
                        self.tool_seq += 1
                        lf.pending[b.get("id")] = {"name": name, "kind": kind, "label": label, "seq": self.tool_seq,
                                                   "target": tool_target(inp), "ts": ts}
                        if name in AGENT_TOOLS and isinstance(inp, dict):
                            lf.launches.append((ts, inp.get("subagent_type") or "", inp.get("description") or "", b.get("id")))
                        if not side:
                            self.emit(lf, ts, "tool", kind=kind, label=label)
            stop = msg.get("stop_reason")
            if had_tool:
                lf.last_kind = "assistant_tool"
            elif stop == "end_turn":
                lf.last_kind = "assistant_end"
            else:
                lf.last_kind = "assistant_text"

    def _stuck_check(self, lf, ts, name, label, err):
        """Claude retrying the same failing thing burns a full conversation's worth of usage each time."""
        lf.recent = (lf.recent + [(name, label, err)])[-6:]
        last3 = lf.recent[-3:]
        if len(last3) == 3 and all(e for _, _, e in last3) and len({(n, l) for n, l, _ in last3}) == 1:
            self.incident(lf, ts, "stuck", "Claude keeps hitting the same error",
                          f"The same step failed 3 times in a row ({label}). If Claude isn't getting closer, press Esc and "
                          f"point it in a new direction. Every retry re-sends the whole conversation.")
            lf.recent = []                          # start counting again, so one bad stretch is one alert
        elif len(lf.recent) == 6 and sum(1 for *_, e in lf.recent if e) >= 5:
            self.incident(lf, ts, "stuck", "Lots of failures in a row",
                          "5 of Claude's last 6 tool calls failed. If it's going in circles, press Esc and redirect it "
                          "before it spends more.")
            lf.recent = []

    # -- snapshot for the page --
    def snapshot(self, since, want=None):
        now = time.time()
        with self.lock:
            mains = [f for f in self.files.values() if not f.is_sub and f.sid]
            active = [f for f in mains if f.status(now) != "idle"]
            pool = active or [f for f in mains if now - f.active_at() < 3600]
            focus = max(pool, key=lambda f: f.active_at()) if pool else None
            pinned = next((f for f in mains if f.sid == want), None) if want else None
            if pinned:
                focus = pinned
            recent = sorted([f for f in mains if now - f.active_at() < LIVE_WINDOW_SECONDS],
                            key=lambda f: -f.active_at())[:12]
            out = {"now": now, "seq": self.seq, "focus": None, "agents": [], "incidents": list(self.incidents),
                   "events": [e for e in self.events if e["seq"] > since], "pinned": bool(pinned),
                   "sessions": [{"id": f.sid, "title": f.summary or f.title or "Untitled session",
                                 "project": f.cwd or "", "status": f.status(now), "at": f.active_at()} for f in recent]}
            if focus:
                st = focus.status(now)
                lc = focus.last_call
                ttl = 3600 if focus.ttl_1h else 300
                ctx_tokens = (lc["in"] + lc["cw"] + lc["cr"]) if lc else 0
                model = (lc or {}).get("model", "")
                window = 1_000_000 if ("1m" in model.lower() or ctx_tokens > 200_000) else 200_000
                out["focus"] = {
                    "id": focus.sid, "title": focus.summary or focus.title or "Current session",
                    "project": focus.cwd or "", "branch": focus.branch or "", "status": st,
                    "activity": focus.current_activity() if st == "working" else None,
                    # transcripts don't record permission prompts; a tool that's quiet for a while may be one
                    "quiet": st == "working" and now - focus.active_at() > 20
                             and any(i["name"] not in AGENT_TOOLS for i in focus.pending.values()),
                    "turnStart": focus.turn_start.timestamp() if focus.turn_start else None,
                    "model": pretty_model(model),
                    "ctx": ctx_tokens, "ctxWindow": window,
                    "cacheExpires": (lc["ts"].timestamp() + ttl) if lc and lc["ts"] else None, "cacheTtl": ttl,
                    "journal": {"turns": focus.journal["turns"], "edits": focus.journal["edits"],
                                "commands": focus.journal["commands"], "fixes": focus.journal["fixes"],
                                "files": len(focus.files)},
                    "bug": focus.bash_failing,
                }
                agents = []
                # subagents of the focused session
                subs = sorted([f for f in self.files.values() if f.is_sub and f.parent_sid == focus.sid],
                              key=lambda f: f.first_ts or datetime.min.replace(tzinfo=timezone.utc))
                used = set()
                for sf in subs:
                    sst = sf.status(now)
                    if sst in ("idle", "your_turn"):
                        continue
                    meta = None
                    for launch in focus.launches:      # earliest unused launch that came before this subagent
                        if launch[3] in used:
                            continue
                        if not sf.first_ts or not launch[0] or launch[0] <= sf.first_ts + timedelta(seconds=5):
                            meta = launch
                            break
                    if meta:
                        used.add(meta[3])
                    act = sf.current_activity()
                    agents.append({"id": hashlib.sha1(sf.path.encode()).hexdigest()[:10], "kind": "subagent",
                                   "role": role_for(meta[1] if meta else ""), "type": meta[1] if meta else "",
                                   "label": (act or {}).get("label") or (meta[2] if meta else "thinking")})
                # agent calls still waiting on a result (older Claude Code keeps subagents in the main file)
                waiting = [tid for tid, info in focus.pending.items() if info["name"] in AGENT_TOOLS and tid not in used]
                missing = sum(1 for i in focus.pending.values() if i["name"] in AGENT_TOOLS) - len(agents)
                for tid in waiting[:max(0, missing)]:
                    launch = next((l for l in focus.launches if l[3] == tid), None)
                    agents.append({"id": (tid or "x")[:10], "kind": "subagent", "role": role_for(launch[1] if launch else ""),
                                   "type": launch[1] if launch else "", "label": launch[2] if launch else "working"})
                # other sessions working at the same time (parallel threads)
                for other in active:
                    if other is focus:
                        continue
                    ost = other.status(now)
                    if ost not in ("working", "thinking"):
                        continue
                    act = other.current_activity()
                    agents.append({"id": (other.sid or "")[:10], "kind": "thread", "role": "thread", "type": "thread",
                                   "label": (act or {}).get("label") or (other.summary or other.title or "thinking")[:40]})
                out["agents"] = agents
            return out


# ===========================================================================
# Harness: Claude Code hooks that trim wasteful tool calls (see harness.py)
# ===========================================================================
HARNESS_SCRIPT = HERE / "harness.py"
RULES_FILE = STATE_DIR / "harness-rules.json"
HLOG_FILE = STATE_DIR / "harness-log.jsonl"
NOISY_MIN_TOKENS = 5_000


def claude_settings_path():
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(cfg).expanduser() if cfg else Path.home() / ".claude") / "settings.json"


def hook_python():
    """A console Python for the hook (pythonw has no output, and hooks answer on stdout)."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and (exe.parent / "python.exe").exists():
        exe = exe.parent / "python.exe"
    return exe


def hook_entry():
    """Exec form (program plus args): no shell is involved, so spaces, quotes or & in a path can't break it."""
    return {"type": "command", "command": hook_python().as_posix(), "args": [HARNESS_SCRIPT.as_posix()], "timeout": 10}


def is_mallow_hook(h):
    return isinstance(h, dict) and "harness.py" in (str(h.get("command", "")) + " ".join(map(str, h.get("args", []))))


class Harness:
    def __init__(self, root, report):
        self.root = root
        self.report = report
        self.lock = threading.Lock()

    # -- rules learned from history --
    def learn(self):
        """Build, test and install commands whose logs were huge, per project.
        Only commands harness.runner_key recognises count: reading commands (cat, sed, grep, git diff, scripts)
        print what Claude asked to see, so trimming them only sends Claude back for it."""
        H = harness_module()
        groups = {}
        for s in self.report.get().get("sessions", []):
            for f in s.get("findings", []):
                if f.get("kind") == "Big tool result" and f.get("tool") == "Bash" and f.get("toks", 0) >= NOISY_MIN_TOKENS:
                    key = H.runner_key(f.get("target", ""))
                    if key:
                        g = groups.setdefault(key, {"key": key, "times": 0, "total": 0, "projects": set()})
                        g["times"] += 1
                        g["total"] += f["toks"]
                        g["projects"].add(s.get("project", ""))
        out = []
        for g in groups.values():
            avg = g["total"] / g["times"]
            if g["times"] >= 2:
                out.append({"key": g["key"], "times": g["times"], "avg_tokens": round(avg),
                            "projects": sorted(p for p in g["projects"] if p and not p.startswith("("))[:10]})
        return sorted(out, key=lambda c: -c["avg_tokens"] * c["times"])

    def rules(self):
        try:
            r = json.loads(RULES_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            r = {}
        r.setdefault("enabled", True)
        for k, v in {"enabled": True, "min_bytes": 60000, "lines": 600}.items():
            r.setdefault("read", {}).setdefault(k, v)
        for k, v in {"enabled": True, "tail": 60, "commands": []}.items():
            r.setdefault("bash", {}).setdefault(k, v)
        H = harness_module()
        # rules from older Mallow builds matched any command (cat, sed, cd "folder"...); drop those
        known = {c["key"]: c for c in r["bash"].get("commands", []) if H.runner_key(c.get("key", "")) == c.get("key")}
        for c in self.learn():                         # add new suggestions; keep the user's on/off choices
            old = known.get(c["key"])
            known[c["key"]] = {**c, "enabled": old.get("enabled", True) if old else True,
                               "tail": (old or {}).get("tail", r["bash"].get("tail", 60))}
        r["bash"]["commands"] = sorted(known.values(), key=lambda c: -c.get("avg_tokens", 0))
        # the hook only reads the file, so newly learned (or dropped) rules have to be written out to take effect
        try:
            on_disk = json.loads(RULES_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            on_disk = None
        if on_disk != r:
            try:
                self.save_rules(r)
            except OSError:
                pass
        return r

    def save_rules(self, r):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = RULES_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(r, indent=1), encoding="utf-8")
        tmp.replace(RULES_FILE)

    # -- install into Claude Code --
    def installed(self):
        try:
            data = json.loads(claude_settings_path().read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return False
        hooks = data.get("hooks") if isinstance(data, dict) else None
        for group in (hooks if isinstance(hooks, dict) else {}).get("PreToolUse", []) or []:
            if isinstance(group, dict) and any(is_mallow_hook(h) for h in group.get("hooks", []) or []):
                return True
        return False

    def _edit_settings(self, change):
        """Change ~/.claude/settings.json safely: back it up, refuse anything unreadable, write atomically,
        follow a symlink to the real file, and report problems instead of crashing."""
        path = claude_settings_path()
        try:
            real = path.resolve()                    # a symlinked settings file stays a symlink
        except OSError:
            real = path
        try:
            text = real.read_text(encoding="utf-8-sig")   # Notepad may add a byte-order mark
            data = json.loads(text) if text.strip() else {}
        except FileNotFoundError:
            text, data = "", {}
        except ValueError:
            return False, "Your Claude Code settings file has something Mallow can't read, so he left it alone."
        except OSError as e:
            return False, f"Couldn't open the Claude Code settings: {e}"
        if not isinstance(data, dict) or not isinstance(data.get("hooks", {}) or {}, dict) \
                or not isinstance(data.get("env", {}) or {}, dict):
            return False, "Your Claude Code settings are shaped in a way Mallow doesn't expect, so he left them alone."
        if data.get("hooks") is None:
            data.pop("hooks", None)
        if data.get("env") is None:
            data.pop("env", None)
        tmp = real.with_name(real.name + ".mallow-tmp")
        try:
            if text:
                STATE_DIR.mkdir(parents=True, exist_ok=True)
                backup = STATE_DIR / f"settings-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
                backup.write_text(text, encoding="utf-8")
            change(data)
            real.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            tmp.replace(real)
        except (OSError, TypeError, AttributeError) as e:
            try:
                tmp.unlink()
            except OSError:
                pass
            return False, f"Couldn't save the Claude Code settings ({e}). Nothing was changed."
        return True, ""

    def install(self):
        def change(data):
            hooks = data.setdefault("hooks", {})
            groups = [g for g in hooks.get("PreToolUse", []) or []
                      if not (isinstance(g, dict) and any(is_mallow_hook(h) for h in g.get("hooks", []) or []))]
            groups.append({"matcher": "Read|Bash", "hooks": [hook_entry()]})
            hooks["PreToolUse"] = groups
        with self.lock:
            r = self.rules()
            r["enabled"] = True                         # turning it on also ends a pause
            self.save_rules(r)
            return self._edit_settings(change)

    def uninstall(self):
        def change(data):
            hooks = data.get("hooks") or {}
            groups = []
            for g in hooks.get("PreToolUse", []) or []:
                if not isinstance(g, dict):
                    groups.append(g)
                    continue
                g = dict(g)
                g["hooks"] = [h for h in g.get("hooks", []) if not is_mallow_hook(h)]
                if g["hooks"]:
                    groups.append(g)
            if groups:
                hooks["PreToolUse"] = groups
            else:
                hooks.pop("PreToolUse", None)
            if not hooks:
                data.pop("hooks", None)
        with self.lock:
            return self._edit_settings(change)

    def set_rule(self, body):
        with self.lock:
            r = self.rules()
            what = body.get("rule")
            on = bool(body.get("enabled"))
            if what == "all":
                r["enabled"] = on
            elif what == "read":
                r["read"]["enabled"] = on
            elif what == "bash":
                for c in r["bash"]["commands"]:
                    if c["key"] == body.get("key"):
                        c["enabled"] = on
            self.save_rules(r)
            return r

    # -- what it has done --
    def stats(self):
        now = time.time()
        week = total = n = 0
        recent = []
        try:
            with open(HLOG_FILE, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        e = json.loads(line)
                    except ValueError:
                        continue
                    n += 1
                    total += e.get("saved", 0)
                    if now - e.get("ts", 0) < 7 * 86400:
                        week += e.get("saved", 0)
                    recent.append(e)
        except OSError:
            pass
        return {"count": n, "savedTotal": round(total), "savedWeek": round(week), "recent": recent[-8:][::-1]}

    # -- measured on your own history, no model calls --
    def measure(self):
        """Replays past sessions through the current rules. For every call a rule would have trimmed it
        counts what would have been removed (and re-sent on each later turn), minus what the harness adds.
        best: Claude never needed the trimmed part. worst: every trim made Claude go back for it with an
        extra call, so nothing was saved and the extra call and note were pure cost."""
        rep = self.report.get()
        if getattr(self, "_mkey", None) == (rep["generated"], RULES_FILE.stat().st_mtime if RULES_FILE.exists() else 0):
            return self._measure
        rules = self.rules()
        H = harness_module()
        out = {"sessions": 0, "best": 0.0, "worst": 0.0, "total": 0.0, "read": 0, "bash": 0, "rules": {}}
        for s in self.report.raw:
            calls = sorted([c for c in s.calls if c["ts"]], key=lambda c: c["ts"])
            main = [c for c in calls if not c["sub"]]
            if not main:
                continue
            out["sessions"] += 1
            out["total"] += sum(call_cost(c) for c in calls)
            mult = model_mult(main[0]["model"])
            comp = sorted(s.compactions)
            for tid, chars, ts, sub in s.results:
                if sub or ts is None:
                    continue
                name, target, _ = s.tools.get(tid, ("?", "", sub))
                info, meta = s.tinfo.get(tid, {}), s.rmeta.get(tid, {})
                lines = max(1, meta.get("lines", 1))
                stop = next((t for t in comp if t > ts), None)
                later = sum(1 for c in main if c["ts"] > ts and (stop is None or c["ts"] < stop))
                carry = (WEIGHTS["cache_write_5m"] + later * WEIGHTS["cache_read"]) * mult
                before = [c for c in main if c["ts"] <= ts]
                ctx_now = ctx(before[-1]) if before else ctx(main[0])
                extra_call = (ctx_now * WEIGHTS["cache_read"] + 150 * WEIGHTS["output"]) * mult
                key, keep, note = None, 0, 0
                if name == "Read" and rules["read"]["enabled"] and not info.get("ranged") \
                        and chars >= rules["read"]["min_bytes"] and lines > rules["read"]["lines"]:
                    key, keep, note = "read", rules["read"]["lines"], 35
                    chunks = -(-(lines - keep) // keep)
                elif name == "Bash" and rules["bash"]["enabled"] and not info.get("bg"):
                    cmd = info.get("cmd") or target
                    rule = H.match_rule(cmd, s.cwd, rules)
                    keep = (rule or {}).get("tail", 60) + 20           # the tail plus a few error lines
                    if rule and lines > keep:
                        # if Claude needs more it reads the saved log instead of running the command again
                        key, note, chunks = rule["key"], 45, 1
                if not key:
                    continue
                trimmed = chars * (1 - keep / lines) / CHARS_PER_TOKEN
                best = (trimmed - note) * carry
                worst = -(note * carry + chunks * extra_call)
                r = out["rules"].setdefault(key, {"times": 0, "best": 0.0, "worst": 0.0})
                r["times"] += 1
                r["best"] += best
                r["worst"] += worst
                out["best"] += best
                out["worst"] += worst
                out["read" if key == "read" else "bash"] += 1
        for r in out["rules"].values():
            r["best"], r["worst"] = round(r["best"]), round(r["worst"])
        out["best"], out["worst"], out["total"] = round(out["best"]), round(out["worst"]), round(out["total"])
        self._mkey = (rep["generated"], RULES_FILE.stat().st_mtime if RULES_FILE.exists() else 0)
        self._measure = out
        return out

    def verify(self):
        """Checks each logged trim against the session transcript: did Claude really get the short version?"""
        raw = {s.sid: s for s in self.report.raw}
        H = harness_module()
        res = {"checked": 0, "delivered": 0, "notDelivered": 0, "pending": 0, "followedUp": 0}
        entries = []
        try:
            with open(HLOG_FILE, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        e = json.loads(line)
                    except ValueError:                  # a half-written line shouldn't hide the rest
                        continue
                    if isinstance(e, dict) and "ts" in e and "kind" in e:
                        entries.append(e)
        except OSError:
            pass
        for e in entries[-200:]:
            s = raw.get(e.get("session"))
            if not s:
                res["pending"] += 1
                continue
            found, at = None, None
            for tid, chars, ts, sub in s.results:
                if ts is None or ts.timestamp() < e["ts"] - 2:
                    continue
                name, target, _ = s.tools.get(tid, ("?", "", sub))
                cmd = s.tinfo.get(tid, {}).get("cmd") or target
                # the transcript keeps what Claude asked for; the result shows what actually ran
                if e["kind"] == "read" and name == "Read" and target == e["target"]:
                    found, at = s.rmeta.get(tid, {}).get("lines", 0) <= e["kept"] + 10, ts
                    break
                if e["kind"] == "bash" and name == "Bash" and H.runner_key(cmd) == e["target"]:
                    found, at = s.rmeta.get(tid, {}).get("lines", 0) <= e["kept"] + 45, ts
                    break
            if found:
                # did Claude go back for what was trimmed? (the next 4 calls: same file read again, or same command rerun)
                nxt = [(s.tools.get(t, ("?", "", 0)), s.tinfo.get(t, {})) for t, c2, t2, sb in s.results
                       if t2 and t2 > at and not sb][:4]
                logfile = str(e.get("file") or "").replace("\\", "/").lower()
                if any((n == "Read" and tg == e["target"]) or
                       (n == "Read" and logfile and str(tg).replace("\\", "/").lower() == logfile) or
                       (n == "Bash" and (e["kind"] == "bash" and H.runner_key(i.get("cmd") or tg) == e["target"]))
                       for (n, tg, _), i in nxt):
                    res["followedUp"] += 1
            if found is None:
                res["pending"] += 1
            else:
                res["checked"] += 1
                res["delivered" if found else "notDelivered"] += 1
        return res

    def state(self):
        return {"installed": self.installed(), "rules": self.rules(), "stats": self.stats(),
                "measure": self.measure(), "verify": self.verify(),
                "settingsPath": str(claude_settings_path()), "platform": sys.platform,
                "startup": startup_enabled(), "tuneups": Tuneups(self).state()}


# ===========================================================================
# Tune-ups: Claude Code settings that cut background usage without touching
# what Claude sees or how it thinks. Each one is a switch; turning it off puts
# the setting back exactly as it was.
# ===========================================================================
TUNEUPS = [
    {"id": "suggestions", "key": "promptSuggestionEnabled", "on": False, "recommended": True,
     "title": "No prompt suggestions",
     "desc": "Claude Code stops guessing your next message after each reply. Each guess is a small extra request on the whole conversation. You lose the grey suggested text in the input box."},
    {"id": "checkins", "env": "CLAUDE_CODE_GOAL_CHECKIN_MINUTES", "on": "0", "recommended": False,
     "title": "No idle goal check-ins",
     "desc": "Only matters if you use /goal. While you're away, Claude won't start turns on its own to check background work. It checks when you next type."},
    {"id": "inbound", "key": "crossSessionInbound", "on": "hold", "recommended": False,
     "title": "Hold messages from other sessions",
     "desc": "Only matters if your sessions message each other. An idle session shows a notice instead of starting a turn. Leave this off if your sessions coordinate on their own."},
]
TUNE_FILE = STATE_DIR / "tuneups.json"


class Tuneups:
    def __init__(self, harness):
        self.h = harness

    def _saved(self):
        try:
            return json.loads(TUNE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _current(self, data, t):
        if "env" in t:
            env = data.get("env") or {}
            return (t["env"] in env, env.get(t["env"]))
        return (t["key"] in data, data.get(t["key"]))

    def state(self):
        try:
            data = json.loads(claude_settings_path().read_text(encoding="utf-8-sig") or "{}")
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        out = []
        for t in TUNEUPS:
            has, val = self._current(data, t)
            out.append({"id": t["id"], "title": t["title"], "desc": t["desc"], "recommended": t["recommended"],
                        "on": has and val == t["on"]})
        return out

    def set(self, tid, on):
        t = next((x for x in TUNEUPS if x["id"] == tid), None)
        if not t:
            return False, "unknown setting"
        saved = self._saved()

        def change(data):
            has, val = self._current(data, t)
            box = data.setdefault("env", {}) if "env" in t else data
            name = t["env"] if "env" in t else t["key"]
            if on:
                if not (has and val == t["on"]):
                    saved[tid] = {"had": has, "prev": val}       # remember exactly what was there
                box[name] = t["on"]
            else:
                prev = saved.pop(tid, {"had": False, "prev": None})
                if prev.get("had"):
                    box[name] = prev.get("prev")
                else:
                    box.pop(name, None)
                if "env" in t and not box:
                    data.pop("env", None)

        with self.h.lock:
            ok, msg = self.h._edit_settings(change)
            if ok:
                STATE_DIR.mkdir(parents=True, exist_ok=True)
                TUNE_FILE.write_text(json.dumps(saved, indent=1), encoding="utf-8")
            return ok, msg


def harness_module():
    """harness.py sits next to this file; import it so both use the exact same matching rules."""
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    import harness
    return harness


# ===========================================================================
# Windows extras: notifications and start with Windows
# ===========================================================================
def notify(title, body):
    """A Windows notification. Quietly does nothing on other systems."""
    if not sys.platform.startswith("win"):
        return
    import subprocess
    # the text travels in environment variables, so nothing in it (quotes of any kind) can change the script
    env = {**os.environ, "MALLOW_T": str(title)[:200], "MALLOW_B": str(body)[:300]}
    ps = ("[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;"
          "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
          "$n = $x.GetElementsByTagName('text'); $n.Item(0).AppendChild($x.CreateTextNode($env:MALLOW_T)) > $null; $n.Item(1).AppendChild($x.CreateTextNode($env:MALLOW_B)) > $null;"
          "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';"
          "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))")
    try:
        subprocess.Popen(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
    except OSError:
        pass


def startup_link():
    appdata = os.environ.get("APPDATA")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "Mallow.lnk" if appdata else None


def startup_enabled():
    link = startup_link()
    return bool(link and link.exists())


def make_shortcut(link_expr):
    """Create a Windows shortcut that starts Mallow. link_expr is a PowerShell expression for the .lnk path.
    It points straight at the windowless Python when there is one, so no console flashes.
    Paths travel in environment variables, so quotes or other odd characters in them can't break the script."""
    import subprocess
    pyw = Path(sys.executable).with_name("pythonw.exe")
    if pyw.exists():
        target, arg, style = pyw, f'"{HERE / "mallow.py"}" --log "{STATE_DIR / "launch.log"}"', 1
    else:
        target, arg, style = HERE / "Open Mallow (Windows).bat", "", 7
    env = {**os.environ, "MALLOW_TARGET": str(target), "MALLOW_ARGS": arg, "MALLOW_DIR": str(HERE),
           "MALLOW_ICON": str(HERE / "mallow.ico") + ",0", "MALLOW_LINK": str(link_expr)}
    ps = ("$l = if ($env:MALLOW_LINK -eq 'DESKTOP') { Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mallow.lnk' } else { $env:MALLOW_LINK };"
          "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($l);"
          "$s.TargetPath=$env:MALLOW_TARGET;$s.Arguments=$env:MALLOW_ARGS;$s.WorkingDirectory=$env:MALLOW_DIR;"
          f"$s.IconLocation=$env:MALLOW_ICON;$s.WindowStyle={style};"
          "$s.Description='Mallow, a hamster who keeps an eye on Claude Code';$s.Save()")
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], env=env,
                           capture_output=True, timeout=30, creationflags=0x08000000)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def set_startup(on):
    link = startup_link()
    if not link:
        return False
    if not on:
        try:
            link.unlink()
        except OSError:
            pass
        return True
    make_shortcut(str(link))
    return link.exists()


def add_to_desktop():
    ok = make_shortcut("DESKTOP")
    print("Mallow is on your desktop. Keep this folder where it is, since the icon points here."
          if ok else "Couldn't make the desktop icon. You can still start Mallow with 'Open Mallow (Windows).bat'.")


# ===========================================================================
# HTTP
# ===========================================================================
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml",
                 ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json"}


def make_handler(watcher, report, port, harness):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = "Mallow"

        def log_message(self, *args):
            pass

        def _host_ok(self):
            return self.headers.get("Host", "") in allowed_hosts

        def _send(self, code, body, ctype="application/json", extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._host_ok():
                return self._send(403, {"error": "forbidden"})
            watcher.last_request = time.time()
            path = self.path.split("?", 1)[0]
            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            if path == "/api/ping":
                return self._send(200, {"app": "mallow", "version": VERSION})
            if path == "/api/live":
                since, want = 0, None
                for part in query.split("&"):
                    if part.startswith("since="):
                        try:
                            since = int(part[6:])
                        except ValueError:
                            pass
                    elif part.startswith("focus="):
                        want = part[6:][:80] or None
                return self._send(200, watcher.snapshot(since, want))
            if path == "/api/harness":
                return self._send(200, harness.state())
            if path == "/api/report":
                return self._send(200, report.get())
            if path == "/":
                path = "/index.html"
            target = (WEB / path.lstrip("/")).resolve()
            if WEB.resolve() not in target.parents or not target.is_file():
                return self._send(404, {"error": "not found"})
            ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
            extra = {"Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"} if target.suffix == ".html" else None
            return self._send(200, target.read_bytes(), ctype, extra)

        def do_POST(self):
            if not self._host_ok() or self.headers.get("X-Mallow") != "1":
                return self._send(403, {"error": "forbidden"})
            watcher.last_request = time.time()
            try:
                length = max(0, min(int(self.headers.get("Content-Length") or 0), 10_000))
                body = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, OSError):
                body = {}
            if not isinstance(body, dict):
                body = {}
            if self.path == "/api/harness":
                act = body.get("action")
                if act == "install":
                    ok, msg = harness.install()
                elif act == "uninstall":
                    ok, msg = harness.uninstall()
                elif act == "rule":
                    harness.set_rule(body)
                    ok, msg = True, ""
                elif act == "startup":
                    ok, msg = set_startup(bool(body.get("enabled"))), ""
                elif act == "tuneup":
                    ok, msg = Tuneups(harness).set(str(body.get("id")), bool(body.get("enabled")))
                else:
                    ok, msg = False, "unknown action"
                return self._send(200, {"ok": ok, "message": msg, **harness.state()})
            if self.path == "/api/quit":                # a newer Mallow is taking over
                self._send(200, {"ok": True})
                threading.Timer(0.2, lambda: os._exit(0)).start()
                return
            if self.path == "/api/notify":
                notify(str(body.get("title", "Mallow"))[:80], str(body.get("body", ""))[:200])
                return self._send(200, {"ok": True})
            if self.path == "/api/ack":
                iid = str(body.get("id", ""))[:40]
                if iid:
                    watcher.ack(iid)
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})

    return Handler


def running_version(port):
    """The version of the Mallow already on this port (0 for builds before versions), or None if it isn't Mallow."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1) as r:
            info = json.loads(r.read())
            return int(info.get("version") or 0) if info.get("app") == "mallow" else None
    except Exception:
        return None


def ask_to_quit(port):
    """Ask an older Mallow to close so this one can take over. True once its port is free."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/quit", data=b"{}", method="POST",
                                     headers={"X-Mallow": "1", "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass
    for _ in range(30):
        time.sleep(0.1)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if not sys.platform.startswith("win"):
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return True
            except OSError:
                continue
    return False


def free_port(preferred):
    """A port to serve on. Negative means the same or a newer Mallow already runs there: just show it."""
    for p in [preferred] + list(range(preferred + 1, preferred + 20)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if not sys.platform.startswith("win"):     # a just-closed Mallow may leave the port briefly waiting
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                pass
        ver = running_version(p)
        if ver is None:
            continue                                   # something else uses this port
        if ver >= VERSION:
            return -p
        if ask_to_quit(p):                             # an older Mallow: replace it
            return p
        # a very old Mallow that can't be asked to quit: run beside it on the next free port
    return 0


def default_root():
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    base = Path(cfg).expanduser() if cfg else Path.home() / ".claude"
    return base / "projects"


APP_BROWSERS = {
    "win32": [r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe", r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
              r"%ProgramFiles%\Google\Chrome\Application\chrome.exe", r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
              r"%LocalAppData%\Google\Chrome\Application\chrome.exe", r"%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"],
    "darwin": ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
               "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
    "linux": ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"],
}


def open_app_window(url):
    """Open Mallow in a window of its own (no tabs or address bar). Returns True if it worked."""
    import shutil
    import subprocess
    plat = "win32" if sys.platform.startswith("win") else "darwin" if sys.platform == "darwin" else "linux"
    for cand in APP_BROWSERS[plat]:
        exe = os.path.expandvars(cand) if plat == "win32" else (cand if plat == "darwin" else shutil.which(cand))
        if exe and os.path.exists(exe):
            try:
                subprocess.Popen([exe, f"--app={url}", "--window-size=1240,900"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return True
            except OSError:
                continue
    return False


NATIVE = {"on": False}         # set while a native window owns Mallow's lifetime


def native_window(url):
    """Show Mallow in a real desktop window (pywebview, using the Edge engine Windows already has).
    Blocks until the window is closed. Returns False if pywebview isn't available or can't start."""
    try:
        import webview
    except Exception:
        return False
    icon = HERE / "mallow.ico"
    if sys.platform.startswith("win"):
        try:                                       # its own taskbar button and icon instead of Python's
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Mallow.Companion")
        except Exception:
            pass
        try:                                       # without Edge WebView2, pywebview drops to old IE: skip it
            from webview.platforms import winforms
            if winforms.renderer != "edgechromium":
                return False
        except Exception as e:
            print(f"Native window unavailable ({e}); using a browser window instead.")
            return False
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        try:
            webview.settings["ALLOW_DOWNLOADS"] = True      # the Export button's "Save as file"
            webview.settings["SHOW_DEFAULT_MENUS"] = False  # no browser right-click menu in the app
        except Exception:
            pass
        NATIVE["on"] = True
        webview.create_window("Mallow", url, width=1240, height=900, min_size=(420, 560),
                              background_color="#E8F3EA", text_select=True)
        # private_mode off keeps your theme, hats and other choices between launches
        webview.start(private_mode=False, storage_path=str(STATE_DIR / "window"),
                      icon=str(icon) if icon.exists() else None)
        return True
    except Exception as e:
        NATIVE["on"] = False
        print(f"Native window unavailable ({e}); using a browser window instead.")
        return False


def show(url, args):
    """Open Mallow: native window first, then an Edge/Chrome app window, then a normal browser tab.
    Returns True if this process should quit now (the native window was closed)."""
    if args.no_open:
        return False
    if not args.browser and native_window(url):
        return True
    if args.browser or not open_app_window(url):
        webbrowser.open(url)
    return False


def main():
    ap = argparse.ArgumentParser(description="Mallow: a live companion for Claude Code.")
    ap.add_argument("--root", type=Path, default=default_root(), help="transcripts folder (default ~/.claude/projects)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-open", action="store_true", help="start without opening a window")
    ap.add_argument("--browser", action="store_true", help="open in a normal browser tab instead of an app window")
    ap.add_argument("--stay", action="store_true", help="keep running even when no window is open")
    ap.add_argument("--log", type=Path, help="append output and errors to this file")
    ap.add_argument("--add-to-desktop", action="store_true", help="Windows: put a Mallow icon on the desktop and exit")
    args = ap.parse_args()
    if args.add_to_desktop:
        add_to_desktop()
        return
    if args.log:
        try:
            args.log.parent.mkdir(parents=True, exist_ok=True)
            big = args.log.exists() and args.log.stat().st_size > 512_000
            fh = open(args.log, "w" if big else "a", encoding="utf-8", buffering=1)
            sys.stdout = sys.stderr = fh
        except OSError:
            pass

    port = free_port(args.port)
    if port < 0:                                   # Mallow is already running: just show it
        url = f"http://127.0.0.1:{-port}/"
        print(f"Mallow is already running at {url}")
        show(url, args)
        return
    if port == 0:
        sys.exit("Couldn't find a free local port.")

    root = args.root.expanduser()
    watcher = Watcher(root)
    report = ReportCache(root)
    watcher.scan()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(watcher, report, port, Harness(root, report)))
    url = f"http://127.0.0.1:{port}/"

    def loop():
        last = time.time()
        while True:
            try:
                watcher.scan()
            except Exception:
                pass
            now = time.time()
            if now - last > 10:            # the computer slept: give the page a moment to wake before deciding it's gone
                watcher.last_request = now
            last = now
            # a native window quits Mallow itself when it closes; only browser windows need the idle timer
            if not args.stay and not NATIVE["on"] and now - watcher.last_request > IDLE_EXIT_SECONDS:
                os._exit(0)
            time.sleep(1.0)

    threading.Thread(target=loop, daemon=True).start()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"Mallow is running at {url}  (it closes itself a few minutes after its window is closed)")

    if show(url, args):
        os._exit(0)                                # native window closed: quit
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
