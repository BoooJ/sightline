# backend/app/api/live.py
"""Revue synchronisée en groupe : un meneur pilote le replay (round, instant, lecture, vitesse, dessins) et les
participants suivent en direct par SSE. Sessions en mémoire, oubliées après 6 h d'inactivité."""
import asyncio
import json
import secrets
import time

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from app.auth.core import current_user
from app.storage.models import User

router = APIRouter(prefix="/api/live", tags=["live"])
TTL_S = 6 * 3600
STATE_KEYS = ("match_id", "round", "tick", "playing", "speed", "shapes", "level")


class LiveSession:
    def __init__(self, leader: str) -> None:
        self.key = secrets.token_urlsafe(16)
        self.leader = leader
        self.state: dict = {}
        self.version = 0
        self.subs: set[asyncio.Queue] = set()
        self.leader_subs: set[asyncio.Queue] = set()  # le meneur écoute aussi, sans compter comme participant
        self.touched = time.time()

    def snapshot(self) -> dict:
        return {**self.state, "version": self.version, "leader": self.leader, "viewers": len(self.subs), "sent_at": time.time()}

    def broadcast(self) -> None:
        snap = self.snapshot()
        for q in list(self.subs | self.leader_subs):
            if q.qsize() > 20:  # participant trop lent : on ne garde que le plus récent
                while not q.empty():
                    q.get_nowait()
            q.put_nowait(snap)


_sessions: dict[str, LiveSession] = {}


def _get(code: str) -> LiveSession:
    now = time.time()
    for c in [c for c, s in _sessions.items() if now - s.touched > TTL_S and not s.subs and not s.leader_subs]:
        del _sessions[c]
    s = _sessions.get(code.upper())
    if s is None:
        raise HTTPException(404, "Session terminée ou introuvable")
    return s


@router.post("")
async def create(body: dict = Body(default={}), user: User | None = Depends(current_user)):
    code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
    s = LiveSession(user.display_name if user else str(body.get("name") or "Meneur")[:40])
    s.state = {k: body[k] for k in STATE_KEYS if k in body}
    _sessions[code] = s
    return {"code": code, "key": s.key, **s.snapshot()}


@router.get("/{code}")
async def get(code: str):
    return _get(code).snapshot()


@router.post("/{code}/state")
async def push(code: str, body: dict = Body(...)):
    s = _get(code)
    if body.get("key") != s.key:
        raise HTTPException(403, "Seul le meneur pilote la session")
    s.state.update({k: body[k] for k in STATE_KEYS if k in body})
    s.version += 1
    s.touched = time.time()
    s.broadcast()
    return {"version": s.version, "viewers": len(s.subs)}


@router.delete("/{code}")
async def end(code: str, key: str):
    s = _get(code)
    if key != s.key:
        raise HTTPException(403, "Seul le meneur peut terminer la session")
    s.state["ended"] = True
    s.version += 1
    s.broadcast()
    _sessions.pop(code.upper(), None)
    return {"ok": True}


@router.get("/{code}/events")
async def events(code: str, request: Request, leader: bool = False):
    s = _get(code)
    q: asyncio.Queue = asyncio.Queue()
    group = s.leader_subs if leader else s.subs
    group.add(q)
    q.put_nowait(s.snapshot())
    s.broadcast()  # nombre de participants à jour pour tous

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield {"event": "state", "data": json.dumps(ev)}
                    if ev.get("ended"):
                        break
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}
        finally:
            group.discard(q)
            s.broadcast()

    return EventSourceResponse(gen())
