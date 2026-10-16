"""Softfactory orchestrator API (Cloud Run service).

POST /api/runs        {request: "..."}  -> {run_id}     (Firebase ID token required)
GET  /api/runs/{id}                      -> run document
GET  /api/healthz
The console reads live progress straight from Firestore (runs/{id}/events).
"""
from __future__ import annotations

import os
import threading

import firebase_admin
from firebase_admin import auth as fb_auth
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from . import store
from .pipeline import run_pipeline
from .vertex_proxy import start_in_background

firebase_admin.initialize_app()
start_in_background()
app = FastAPI(title="Softfactory orchestrator")
ALLOW_ANON = os.environ.get("ALLOW_ANON", "false") == "true"  # demo switch for judges


def _uid(authorization: str | None) -> str:
    if ALLOW_ANON and not authorization:
        return "anonymous"
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing Firebase ID token")
    try:
        return fb_auth.verify_id_token(authorization.split(" ", 1)[1])["uid"]
    except Exception as e:  # noqa: BLE001
        raise HTTPException(401, f"invalid token: {e}")


class RunIn(BaseModel):
    request: str


@app.get("/api/healthz")
def healthz():
    return {"ok": True}


@app.post("/api/runs")
def create_run(body: RunIn, authorization: str | None = Header(default=None)):
    uid = _uid(authorization)
    if len(body.request.strip()) < 10:
        raise HTTPException(400, "describe the module in a sentence or more")
    run_id = store.create_run(body.request, uid)
    # Deploy with --no-cpu-throttling so this thread keeps CPU after the response.
    threading.Thread(target=run_pipeline, args=(run_id, body.request), daemon=True).start()
    return {"run_id": run_id}


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    snap = store.db.collection("runs").document(run_id).get()
    if not snap.exists:
        raise HTTPException(404, "run not found")
    return {"id": run_id, **snap.to_dict()}
