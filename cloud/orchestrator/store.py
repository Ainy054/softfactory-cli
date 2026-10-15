"""Firestore persistence for Softfactory runs, gate results and lessons.

Collections
  runs/{run_id}                  status, request, timestamps, result
  runs/{run_id}/events/{auto}    one doc per agent step / gate result (console listens here)
  lessons/{auto}                 error signature -> fix that worked (agents read before each run)
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

from google.cloud import firestore

db = firestore.Client()


def _now():
    return datetime.now(timezone.utc)


def create_run(request_text: str, user_uid: str) -> str:
    ref = db.collection("runs").document()
    ref.set({
        "request": request_text,
        "uid": user_uid,
        "status": "queued",
        "created_at": _now(),
        "updated_at": _now(),
    })
    return ref.id


def set_status(run_id: str, status: str, **extra):
    db.collection("runs").document(run_id).update({"status": status, "updated_at": _now(), **extra})


def log_event(run_id: str, agent: str, state: str, detail: str = "", data: dict | None = None):
    """agent: 'Planner', 'Gate: pylint-odoo', ...  state: running|done|passed|failed|retry"""
    db.collection("runs").document(run_id).collection("events").add({
        "agent": agent,
        "state": state,
        "detail": detail[:4000],
        "data": data or {},
        "at": _now(),
    })


def _signature(error_text: str) -> str:
    """Normalise an error (strip paths, line numbers, ids) so similar failures match."""
    t = re.sub(r"/[\w/.\-]+", "<path>", error_text)
    t = re.sub(r"\d+", "<n>", t)
    t = re.sub(r"\s+", " ", t).strip()[:500]
    return hashlib.sha1(t.encode()).hexdigest()


def add_lesson(error_text: str, fix_summary: str, gate: str, run_id: str):
    sig = _signature(error_text)
    ref = db.collection("lessons").document(sig)
    ref.set({
        "signature": sig,
        "gate": gate,
        "error_example": error_text[:2000],
        "fix": fix_summary[:2000],
        "last_run": run_id,
        "hits": firestore.Increment(1),
        "updated_at": _now(),
    }, merge=True)


def find_lesson(error_text: str) -> dict | None:
    snap = db.collection("lessons").document(_signature(error_text)).get()
    return snap.to_dict() if snap.exists else None


def top_lessons(limit: int = 20) -> list[dict]:
    q = db.collection("lessons").order_by("hits", direction=firestore.Query.DESCENDING).limit(limit)
    return [d.to_dict() for d in q.stream()]
