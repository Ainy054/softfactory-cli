#!/usr/bin/env python3
"""Run softfactory on your Mac and mirror its progress to Firestore (project softfactory-490f2).

The Firebase console (https://softfactory-490f2.web.app) then shows every run, phase and task live.

Setup once:
    pip3 install google-cloud-firestore
    gcloud auth application-default login
    gcloud auth application-default set-quota-project softfactory-490f2

Use (inside a git repo, exactly like the normal command):
    python3 sf_mirror.py "FastAPI service exposing Bank of Mongolia official exchange rates: ..."
    python3 sf_mirror.py --resume            # extra flags are passed through to softfactory
"""
import os
import pty
import re
import select
import subprocess
import sys
from datetime import datetime, timezone

from google.cloud import firestore

PROJECT = os.environ.get("SF_PROJECT", "softfactory-490f2")
FLAGS = ["--strategy=cloud", "--cloud-provider=agy", "--planner-provider=agy",
         "--cloud-model=Gemini 3.7 Flash (High)", "--frontier-model=Gemini 3.1 Pro (High)",
         "--sandbox=auto", "--attempt-timeout", "15", "--run-budget", "60"]

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")
DONE_TASK = re.compile(r"(T\d+)\s+(.+?)\s+\[([a-z_]+)\]\s+\[(Merged|Failed)\]")  # roles: coder, test_writer, devops, docs, ...
TASK = re.compile(r"\[(T\d+)\]\s*(.*)")
PHASE = re.compile(r"Phase (\d+):.*?\]\s*(\d+)/(\d+)")  # "Phase 2: [====] 1/2" and "... 2/2 done"

db = firestore.Client(project=PROJECT)
now = lambda: datetime.now(timezone.utc)


def state_of(text):
    t = text.lower()
    if "fail" in t or "error" in t:
        return "failed"
    if "red as expected" in t:
        return "retry"
    if "passed" in t or "success" in t or "merged" in t or "committed" in t:
        return "passed"
    return "running"


def main():
    args = sys.argv[1:]
    request = next((a for a in args if not a.startswith("--")), "(resume)")
    run = db.collection("runs").document()
    run.set({"request": request, "uid": "anonymous", "status": "running", "source": "cli",
             "cwd": os.path.basename(os.getcwd()), "created_at": now(), "updated_at": now()})
    events = run.collection("events")
    print(f"[mirror] Firestore run {run.id} in project {PROJECT}", flush=True)

    def log(agent, state, detail=""):
        events.add({"agent": agent, "state": state, "detail": detail[:4000], "data": {}, "at": now()})

    seen, buf = set(), ""
    master, slave = pty.openpty()  # keep softfactory's interactive TTY output
    p = subprocess.Popen(["softfactory", *FLAGS, "--yes", *args] if "--resume" not in args
                         else ["softfactory", *args, *FLAGS], stdout=slave, stderr=slave, stdin=slave)
    os.close(slave)
    while True:
        r, _, _ = select.select([master], [], [], 0.5)
        if master in r:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            sys.stdout.buffer.write(chunk); sys.stdout.flush()
            buf += chunk.decode("utf-8", "replace")
            *lines, buf = re.split(r"[\r\n]", buf)
            for raw in lines:
                line = ANSI.sub("", raw).strip()
                if not line or line in seen:
                    continue
                seen.add(line)
                if m := DONE_TASK.search(line):
                    log(f"{m.group(1)} {m.group(3)}", m.group(4).lower(), m.group(2))
                elif m := TASK.search(line):
                    log(m.group(1), state_of(m.group(2)), m.group(2))
                elif m := PHASE.search(line):
                    log(f"Phase {m.group(1)}", "done" if m.group(2) == m.group(3) else "running",
                        f"{m.group(2)}/{m.group(3)}")
                elif "Build completed" in line:
                    log("Factory", "passed", "Build completed")
        elif p.poll() is not None:
            break
    rc = p.wait()
    run.update({"status": "green" if rc == 0 else "failed", "exit_code": rc, "updated_at": now()})
    print(f"\n[mirror] run {run.id} -> {'green' if rc == 0 else 'failed'}", flush=True)
    sys.exit(rc)


if __name__ == "__main__":
    main()
