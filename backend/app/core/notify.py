# backend/app/core/notify.py
"""Notifications d'équipe (comme les alertes « match ready » d'EDGE) : une ligne en base, un événement SSE pour les
clients connectés, et, si un webhook Discord est configuré, un message Discord (sans bloquer l'appelant)."""
from __future__ import annotations

import json
import logging
import threading
import urllib.request

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.storage.models import Notification, Webhook

log = logging.getLogger(__name__)
MAX_KEEP = 500
# alertes qu'un webhook sortant abonné à l'événement (n8n W2) annonce déjà sur Discord : pas de doublon
RELAYED = {"match_ready": "match.ready", "comms": "comms.ready"}


def _relayed(db: Session, kind: str) -> bool:
    event = RELAYED.get(kind)
    if not event:
        return False
    for raw in db.scalars(select(Webhook.events).where(Webhook.active.is_(True))):
        try:
            if event in json.loads(raw or "[]"):
                return True
        except ValueError:
            continue
    return False


def _discord(url: str, text: str) -> None:
    try:
        req = urllib.request.Request(url, data=json.dumps({"content": text[:1900]}).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "User-Agent": "sightline"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:  # noqa: BLE001  (un webhook en panne ne doit jamais casser un import)
        log.warning("webhook Discord : %s", e)


def notify(db: Session, kind: str, title: str, body: str = "", link: str = "", bus=None, settings=None) -> dict:
    """Enregistre la notification (et la diffuse). Appelable depuis un thread : `bus.publish` est thread-safe."""
    n = Notification(kind=kind[:32], title=title[:200], body=body[:500], link=link[:300])
    db.add(n)
    db.flush()
    # on garde les 500 dernières
    extra = db.query(Notification).order_by(Notification.id.desc()).offset(MAX_KEEP).all()
    for old in extra:
        db.delete(old)
    db.commit()
    d = as_dict(n)
    if bus is not None:
        bus.publish({"type": "notification", **d})
    url = getattr(settings, "discord_webhook", "") if settings is not None else ""
    if url and getattr(settings, "notify_discord", True) and not _relayed(db, kind):
        text = f"**{title}**" + (f"\n{body}" if body else "")
        base = getattr(settings, "public_url", "") or ""
        if link and base:
            text += f"\n{base.rstrip('/')}{link}"
        threading.Thread(target=_discord, args=(url, text), daemon=True).start()
    if settings is not None:
        try:  # notifications web de l'app mobile (envoi en fil à part)
            from app.core.push import dispatch
            dispatch(db, settings, kind, title, body, link)
        except Exception as e:  # noqa: BLE001  (une notification web en échec ne doit jamais casser l'appelant)
            log.warning("notifications web : %s", e)
    return d


def as_dict(n: Notification) -> dict:
    return {"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "link": n.link,
            "created_at": n.created_at.isoformat() if n.created_at else None}
