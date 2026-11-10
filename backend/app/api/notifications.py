# backend/app/api/notifications.py
"""Notifications d'équipe : liste (les plus récentes), purge, test du webhook Discord."""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.auth.core import require_admin
from app.core.notify import as_dict, notify
from app.storage.models import Notification, User

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("")
def list_notifications(after: int = 0, limit: int = 50, db: Session = Depends(get_session)):
    q = select(Notification).order_by(Notification.id.desc()).limit(max(1, min(limit, 200)))
    if after:
        q = q.where(Notification.id > after)
    return [as_dict(n) for n in db.scalars(q)]


@router.delete("")
def clear(_: User | None = Depends(require_admin), db: Session = Depends(get_session)):
    db.execute(delete(Notification))
    db.commit()
    return {"ok": True}


@router.post("/test")
def test_webhook(request: Request, _: User | None = Depends(require_admin), db: Session = Depends(get_session)):
    """Envoie une notification de test (en base, SSE et Discord si configuré)."""
    s = request.app.state.settings
    if not s.discord_webhook:
        raise HTTPException(400, "Aucun webhook Discord configuré")
    return notify(db, "test", "Test de notification", "Le webhook Discord est bien configuré.", "/team", bus=request.app.state.bus, settings=s)
