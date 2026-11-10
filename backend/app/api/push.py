# backend/app/api/push.py
"""Abonnement de l'app mobile (version web installée) aux notifications."""
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.auth.core import require_user
from app.core.push import allowed_endpoint, vapid_keys
from app.storage.models import PushSubscription, User

router = APIRouter(prefix="/api/push", tags=["push"])


@router.get("/key")
def key(request: Request):
    """Clé publique VAPID (`applicationServerKey` du navigateur)."""
    _, public = vapid_keys(Path(request.app.state.settings.data_dir))
    return {"key": public}


@router.post("/subscriptions")
def subscribe(body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    if user is None:
        raise HTTPException(400, "Les notifications demandent un compte")
    endpoint = str(body.get("endpoint") or "")
    keys = body.get("keys") or {}
    p256dh, auth = str(keys.get("p256dh") or ""), str(keys.get("auth") or "")
    if not allowed_endpoint(endpoint) or not p256dh or not auth or len(p256dh) > 256 or len(auth) > 64:
        raise HTTPException(400, "Abonnement invalide")
    sub = db.scalar(select(PushSubscription).where(PushSubscription.endpoint == endpoint))
    if sub is None:
        db.add(PushSubscription(user_id=user.id, endpoint=endpoint, p256dh=p256dh, auth=auth))
    else:  # même appareil (réabonnement, ou autre compte sur le même téléphone)
        sub.user_id, sub.p256dh, sub.auth = user.id, p256dh, auth
    db.commit()
    return {"ok": True}


@router.delete("/subscriptions")
def unsubscribe(body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    q = delete(PushSubscription).where(PushSubscription.endpoint == str(body.get("endpoint") or ""))
    if user is not None:
        q = q.where(PushSubscription.user_id == user.id)
    db.execute(q)
    db.commit()
    return {"ok": True}
