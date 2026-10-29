#!/usr/bin/env python3
"""Reduce a Claude Code transcript (.jsonl) to the rows and timing spans of the trajectory trace.

Usage: ledger.py TRANSCRIPT. Prints {"rows": [...], "spans": [...]} as JSON.
A mod may not read a file over 4 MiB, and a long session's transcript is far larger, so the reduction
happens here and only the small result crosses into the mod.

row:  {k, n, at, ms, text, result, err}   k is system | user | context | assistant | tool; n is the turn
span: [n, kind, ms]                        kind is i (a prompt arrived), m (model), t (tool), e (tool failed)
"""
import json
import re
import sys
from datetime import datetime

MAX_ROWS = 1500
MODEL_CAP = 600_000


def cut(text, limit):
    flat = re.sub(r"\s+", " ", text or "").strip()
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def text_of(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and isinstance(p.get("text"), str))


def brief_of(name, inp):
    s = lambda k: inp.get(k) if isinstance(inp.get(k), str) else ""
    if name == "Bash":
        return cut(s("command"), 90)
    if name in ("Read", "Edit", "Write", "NotebookEdit"):
        return s("file_path")
    if name in ("Grep", "Glob"):
        return cut(s("pattern"), 70)
    if name == "Agent":
        return cut(s("description") or s("prompt"), 70)
    if name == "Skill":
        return s("skill")
    return cut(json.dumps(inp), 90)


def stamp(value):
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def classify(content):
    """('user', text) for something the person typed, ('context', text) for injected text, or None."""
    text = text_of(content).strip()
    if not text:
        return None
    m = re.search(r"<command-name>/?([^<]+)</command-name>", text)
    if m:
        return ("user", "/" + m.group(1))
    if text.startswith("[Request interrupted"):
        return ("context", text)
    if text.startswith(("<", "This session is being continued", "Base directory for this skill", "Claude Code sent this note")):
        return ("context", text)
    return ("user", text)


def main(path):
    rows = [{"k": "system", "n": 0, "at": 0, "ms": 0, "text": "Initial System Prompt", "result": "", "err": False}]
    spans = []
    by_call, by_msg = {}, {}
    n, last_in = 0, None

    def add(k, at, text, ms=0, result="", err=False):
        row = {"k": k, "n": n, "at": at, "ms": ms, "text": text, "result": result, "err": err}
        rows.append(row)
        return row

    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except Exception:
                continue
            at = stamp(r.get("timestamp") or "")
            if at is None or r.get("isSidechain") is True:
                continue
            kind = r.get("type")
            msg = r.get("message") or {}
            if kind == "system" and r.get("subtype") == "compact_boundary":
                add("system", at, "Conversation compacted")
            elif kind == "attachment":
                a = r.get("attachment") or {}
                body = a.get("content") if isinstance(a.get("content"), str) else a.get("type", "attachment")
                add("context", at, cut(str(body), 200))
            elif kind == "user":
                content = msg.get("content")
                results = [p for p in content if isinstance(p, dict) and p.get("type") == "tool_result"] if isinstance(content, list) else []
                for res in results:
                    row = by_call.get(res.get("tool_use_id"))
                    if row:
                        row["ms"] = max(0, at - row["at"])
                        row["err"] = res.get("is_error") is True
                        row["result"] = cut(text_of(res.get("content")), 300)
                        spans.append([row["n"], "e" if row["err"] else "t", row["ms"]])
                    last_in = at
                if not results:
                    got = classify(content)
                    if got is None:
                        continue
                    if got[0] == "user":
                        n += 1
                        add("user", at, cut(got[1], 300))
                        spans.append([n, "i", 0])
                        last_in = at
                    else:
                        add("context", at, cut(got[1], 200))
            elif kind == "assistant":
                mid = msg.get("id")
                if mid not in by_msg:
                    by_msg[mid] = {"row": None}
                    if last_in is not None:
                        spans.append([n, "m", min(MODEL_CAP, max(0, at - last_in))])
                        last_in = at
                state = by_msg[mid]
                for part in msg.get("content") or []:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "text" and part.get("text", "").strip():
                        if state["row"] is None:
                            state["row"] = add("assistant", at, cut(part["text"], 300))
                        else:
                            state["row"]["text"] = cut(state["row"]["text"] + " " + part["text"], 300)
                    elif part.get("type") == "tool_use":
                        inp = part.get("input") if isinstance(part.get("input"), dict) else {}
                        name = str(part.get("name"))
                        by_call[part.get("id")] = add("tool", at, f"{name} {brief_of(name, inp)}")

    keep = rows[-MAX_ROWS:]
    first = keep[0]["n"] if keep else 0
    json.dump({"rows": keep, "spans": [s for s in spans if s[0] >= first]}, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv[1])
