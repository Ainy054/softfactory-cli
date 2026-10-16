"""Loopback OpenAI-compatible endpoint backed by Gemini on Vertex AI.

softfactory's `openai-compat` provider takes a base URL and a static key, but a
Vertex access token expires after an hour, shorter than a run. This proxy listens
on 127.0.0.1 only, adds a fresh token from the service account (or local ADC) to
each request, and forwards it to Vertex's OpenAI-compatible endpoint. Billing is
the project's own Cloud billing, so no Gemini API key is involved.

    SOFTFACTORY_COMPAT_BASE_URL=http://127.0.0.1:18081/v1
"""
from __future__ import annotations

import json
import os
import threading

import google.auth
import google.auth.transport.requests
import httpx
import uvicorn
from fastapi import Body, FastAPI, Response

PORT = int(os.environ.get("VERTEX_PROXY_PORT", "18081"))
LOCATION = os.environ.get("VERTEX_LOCATION", "global")

_creds, _default_project = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or _default_project
HOST = "aiplatform.googleapis.com" if LOCATION == "global" else f"{LOCATION}-aiplatform.googleapis.com"
UPSTREAM = f"https://{HOST}/v1/projects/{PROJECT}/locations/{LOCATION}/endpoints/openapi"
_lock = threading.Lock()

app = FastAPI(title="Vertex proxy")
_client = httpx.Client(timeout=httpx.Timeout(900.0, connect=30.0))


def _token() -> str:
    with _lock:
        if not _creds.valid:
            _creds.refresh(google.auth.transport.requests.Request())
        return _creds.token


@app.get("/v1/models")
def models():
    # Vertex's compat endpoint has no model listing; softfactory treats an empty one as advisory.
    return {"object": "list", "data": []}


# Gemini 3 rejects a replayed function call without the thought_signature it was
# issued with, and OpenAI-style clients drop the field. Remember each signature by
# tool-call id and put it back; an unknown id gets Google's documented bypass value.
_signatures: dict[str, str] = {}
_SKIP_SIGNATURE = "skip_thought_signature_validator"


def _restore_signatures(payload: dict) -> None:
    for message in payload.get("messages") or []:
        if message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            google_extra = call.setdefault("extra_content", {}).setdefault("google", {})
            if not google_extra.get("thought_signature"):
                google_extra["thought_signature"] = _signatures.get(call.get("id", ""), _SKIP_SIGNATURE)


def _remember_signatures(data: dict) -> None:
    for choice in data.get("choices") or []:
        for call in (choice.get("message") or {}).get("tool_calls") or []:
            signature = ((call.get("extra_content") or {}).get("google") or {}).get("thought_signature")
            if signature and call.get("id"):
                with _lock:
                    if len(_signatures) > 20000:
                        _signatures.clear()
                    _signatures[call["id"]] = signature


# A plain def runs in FastAPI's thread pool, so parallel workers' calls overlap.
@app.post("/v1/chat/completions")
def chat(payload: dict = Body(...)):
    _restore_signatures(payload)
    r = _client.post(f"{UPSTREAM}/chat/completions", content=json.dumps(payload),
                     headers={"Authorization": f"Bearer {_token()}", "Content-Type": "application/json"})
    if r.status_code == 200:
        try:
            _remember_signatures(r.json())
        except ValueError:
            pass  # not JSON: pass it through unchanged; the client reports it
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


def start_in_background() -> None:
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning"))
    threading.Thread(target=server.run, daemon=True, name="vertex-proxy").start()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
