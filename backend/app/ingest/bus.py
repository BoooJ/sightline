# backend/app/ingest/bus.py
from __future__ import annotations

import asyncio


class ProgressBus:
    """Pub/sub en mémoire ; publish() est utilisable depuis n'importe quel thread."""

    def __init__(self) -> None:
        self._subs: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def _deliver(self, event: dict) -> None:
        for q in list(self._subs):
            if q.full():
                q.get_nowait()
            q.put_nowait(event)

    def publish(self, event: dict) -> None:
        loop = self._loop
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if loop is None or running is loop:
            self._deliver(event)
        else:
            loop.call_soon_threadsafe(self._deliver, event)
