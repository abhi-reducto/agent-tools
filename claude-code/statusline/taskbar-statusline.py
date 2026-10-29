#!/usr/bin/env python3
import json, subprocess, sys, os, time, hashlib

d = json.load(sys.stdin)
R = "\033[0m"
def c(code, s): return f"\033[{code}m{s}{R}"
def run(argv, cwd, t=5):
    try:
        r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=t)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""

cwd = (d.get("workspace") or {}).get("current_dir") or d.get("cwd") or os.getcwd()
parts = []

home = os.path.expanduser("~")
parts.append(c("94", "~" + cwd[len(home):] if cwd == home or cwd.startswith(home + "/") else cwd))

pct =(d.get("context_window") or {}).get("used_percentage")
if pct is not None:
    col = "31" if pct >= 85 else "33" if pct >= 60 else "32"
    filled = round(min(max(pct, 0), 100) / 10)
    parts.append(c(col, f"ctx {'█' * filled}{'░' * (10 - filled)} {round(pct)}%"))
else:
    parts.append(c("90", "ctx –"))

model = (d.get("model") or {}).get("display_name")
if model:
    parts.append(c("38;5;208", model))

branch = run(["git", "branch", "--show-current"], cwd)
if branch:
    parts.append(c("36", branch))
    # cache the PR lookup per cwd+branch so gh runs at most every 60s
    key = hashlib.md5(f"{cwd}:{branch}".encode()).hexdigest()
    cache = f"/tmp/taskbar-pr-{key}"
    pr = None
    if os.path.exists(cache) and time.time() - os.path.getmtime(cache) < 60:
        pr = open(cache).read()
    else:
        out = run(["gh", "pr", "view", "--json", "number,url"], cwd, 8)
        try:
            j = json.loads(out)
            pr = f"#{j['number']} {j['url']}"
        except Exception:
            pr = ""
        open(cache, "w").write(pr)
    if pr:
        parts.append(c("35", pr))

cost = (d.get("cost") or {}).get("total_cost_usd")
if cost is not None:
    parts.append(c("33;1", f"${cost:.2f}"))

rl = d.get("rate_limits") or {}
for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
    p = (rl.get(key) or {}).get("used_percentage")
    if p is not None:
        col = "31" if p >= 85 else "33" if p >= 60 else "32"
        parts.append(c("34", label + " ") + c(col, f"{round(p)}%"))

print(c("90", " │ ").join(parts))
