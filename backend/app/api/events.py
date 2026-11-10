# backend/app/api/events.py
import asyncio
import json

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

router = APIRouter(prefix="/api", tags=["events"])


@router.get("/events")
async def events(request: Request):
    bus = request.app.state.bus
    q = bus.subscribe()

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield {"event": ev.get("type", "demo"), "data": json.dumps(ev)}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}
        finally:
            bus.unsubscribe(q)

    return EventSourceResponse(gen())
