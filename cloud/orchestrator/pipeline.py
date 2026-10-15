"""Runs softfactory-cli for one request and mirrors its progress into Firestore.

The console (Firebase Hosting) listens to runs/{id}/events, so every line the CLI
prints about a task ([T1] ... [Merged], Verifier PASSED, Quality Inspector ...) shows up live.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess

from google.cloud import storage

from . import store

BUCKET = os.environ.get("ARTIFACT_BUCKET", "")
SF_BIN = os.environ.get("SOFTFACTORY_BIN", "softfactory")
SF_FLAGS = os.environ.get(
    "SOFTFACTORY_FLAGS",
    '--strategy=cloud --cloud-provider=agy --planner-provider=agy '
    '--cloud-model="Gemini 3.7 Flash (High)" --frontier-model="Gemini 3.1 Pro (High)" '
    '--sandbox=auto --attempt-timeout 15 --run-budget 60')

TASK = re.compile(r"\[(T\d+)\]\s*(.*)")
DONE_TASK = re.compile(r"(T\d+)\s+(.+?)\s+\[(coder|test_writer)\]\s+\[(Merged|Failed)\]")
PHASE = re.compile(r"Phase (\d+):.*?(\d+)/(\d+) done")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _state(line: str) -> str:
    l = line.lower()
    if "failed" in l or "error" in l:
        return "failed"
    if "passed" in l or "success" in l or "merged" in l:
        return "passed"
    if "red as expected" in l:
        return "retry"
    return "running"


def run_pipeline(run_id: str, request: str):
    work = f"/tmp/runs/{run_id}"
    os.makedirs(work, exist_ok=True)
    try:
        store.set_status(run_id, "running")
        subprocess.run("git init -q && git commit -q --allow-empty -m init", shell=True, cwd=work, check=True)
        cmd = f'{SF_BIN} {SF_FLAGS} --yes "$REQ"'
        p = subprocess.Popen(cmd, shell=True, cwd=work, env={**os.environ, "REQ": request},
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        seen = set()
        for raw in p.stdout:
            line = ANSI.sub("", raw).strip()
            if not line:
                continue
            if m := DONE_TASK.search(line):
                key = (m.group(1), m.group(4))
                if key not in seen:
                    seen.add(key)
                    store.log_event(run_id, f"{m.group(1)} {m.group(3)}", m.group(4).lower(), m.group(2))
            elif m := TASK.search(line):
                store.log_event(run_id, m.group(1), _state(m.group(2)), m.group(2))
            elif m := PHASE.search(line):
                store.log_event(run_id, f"Phase {m.group(1)}", "done" if m.group(2) == m.group(3) else "running",
                                f"{m.group(2)}/{m.group(3)}")
            elif "Build completed" in line:
                store.log_event(run_id, "Factory", "passed", "Build completed")
        rc = p.wait()
        if rc != 0:
            store.set_status(run_id, "failed", exit_code=rc)
            return
        uri = ""
        if BUCKET:
            zip_base = f"/tmp/{run_id}"
            shutil.make_archive(zip_base, "zip", work)
            blob = storage.Client().bucket(BUCKET).blob(f"runs/{run_id}/repo.zip")
            blob.upload_from_filename(zip_base + ".zip")
            uri = f"gs://{BUCKET}/runs/{run_id}/repo.zip"
        store.set_status(run_id, "green", repo_uri=uri)
    except Exception as e:  # noqa: BLE001
        store.log_event(run_id, "Factory", "failed", repr(e))
        store.set_status(run_id, "error", error=repr(e))
