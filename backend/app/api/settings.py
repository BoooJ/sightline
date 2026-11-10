# backend/app/api/settings.py
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from app.auth.core import current_user, require_admin
from app.core.config import default_config_path, save_settings
from app.storage.models import User

router = APIRouter(prefix="/api/settings", tags=["settings"])
EDITABLE = ("sample_rate", "max_parallel_imports", "trade_window_s", "eco_max", "semi_max", "force_max",
            "discord_webhook", "notify_discord", "public_url")


def _owner(user: User | None) -> bool:
    return user is None or user.role == "owner"  # None : mode ouvert, la machine elle-même


def _public(s, user: User | None) -> dict:
    out = {"demo_folders": [str(p) for p in s.demo_folders], **{k: getattr(s, k) for k in EDITABLE}}
    if not _owner(user):
        out["discord_webhook"] = ""  # l'URL contient le jeton du webhook : le propriétaire seul la voit
    return out


@router.get("")
def get(request: Request, user: User | None = Depends(current_user)):
    return _public(request.app.state.settings, user)


@router.put("")
def put(request: Request, body: dict = Body(...), user: User | None = Depends(require_admin)):
    if "discord_webhook" in body and not _owner(user):
        raise HTTPException(403, "Réservé au propriétaire de l'équipe")
    s = request.app.state.settings
    if "demo_folders" in body:
        s.demo_folders = [Path(p) for p in body["demo_folders"]]
    for k in EDITABLE:
        if k in body:
            setattr(s, k, type(getattr(s, k))(body[k]))
    save_settings(s, s.config_path or default_config_path())
    return _public(s, user)
