# backend/app/api/ai.py
"""Assistant IA : état, configuration (clé et modèle, administrateurs) et conversation en flux (SSE)."""
import json
import re

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.ai import assistant
from app.auth.core import current_user, require_owner
from app.storage.models import User

router = APIRouter(prefix="/api/ai", tags=["ai"])


def _data_dir(request: Request):
    return request.app.state.settings.data_dir


@router.get("/status")
def status(request: Request, user: User | None = Depends(current_user)):
    c = assistant.config(_data_dir(request))
    return {"enabled": bool(c["key"]), "model": c["model"], "provider": c["provider"], "providers": c["providers"],
            "source": c["source"], "models": assistant.MODELS,
            "can_configure": user is None or user.role == "owner"}


@router.put("/config")
async def set_config(request: Request, body: dict = Body(...), _: User | None = Depends(require_owner)):
    """Clé API Anthropic ou Gemini (jamais renvoyée) et modèle. {"api_key": "...", "model": "...", "clear_key": true}."""
    key = (body.get("api_key") or "").strip() or None
    model = body.get("model") or None
    if model and model not in assistant.MODELS:
        raise HTTPException(400, "Modèle inconnu")
    if key:
        if len(key) < 20 or len(key) > 300 or not re.fullmatch(r"[A-Za-z0-9._\-]+", key):
            raise HTTPException(400, "Clé API invalide : collez une clé Anthropic (sk-ant-…) ou Google Gemini")
        try:
            ok = await assistant.check_key(key)
        except Exception:  # noqa: BLE001 — réseau indisponible : on enregistre quand même
            ok = True
        if not ok:
            raise HTTPException(400, f"Clé API refusée par {'Anthropic' if assistant.provider_of_key(key) == 'anthropic' else 'Google'}")
    assistant.save_config(_data_dir(request), api_key=key, model=model, clear_key=bool(body.get("clear_key")))
    return status(request, None)


@router.post("/chat")
async def chat(request: Request, body: dict = Body(...)):
    c = assistant.config(_data_dir(request))
    if not c["key"]:
        raise HTTPException(409, "Assistant non configuré : ajoutez une clé API Anthropic")
    messages = body.get("messages") or []
    if not messages or not isinstance(messages, list) or len(messages) > 60:
        raise HTTPException(400, "Conversation invalide")
    for m in messages:
        if not isinstance(m.get("content"), str) or len(m["content"]) > 8000:
            raise HTTPException(400, "Message invalide")

    async def events():
        async for ev in assistant.chat(request.app, dict(request.cookies), c["key"], c["model"], messages, body.get("context")):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
