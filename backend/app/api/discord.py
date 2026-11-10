"""Bot Discord de l'équipe : commande /demos, qui met en file des démos FACEIT d'un adversaire (app.integrations.faceit_demos).

Discord appelle Sightline à chaque commande (« Interactions Endpoint URL » de l'application) : requête signée Ed25519,
vérifiée avec la clé publique de l'application ; rien ne tourne en plus sur le serveur. La réponse part tout de suite
(« Sightline réfléchit… »), puis le message est complété une fois les démos choisies. Le jeton du bot ne sert qu'à
enregistrer la commande : gardé dans les secrets du serveur, il n'est jamais renvoyé."""
from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session, sessionmaker

from app.api.deps import get_session, get_settings
from app.auth.core import require_owner
from app.core.config import Settings
from app.core.secrets import read_secrets, write_secrets
from app.faceit.client import FaceitClient, FaceitError, api_key
from app.integrations import faceit_demos, utcnow
from app.maps.registry import MapMeta
from app.storage.models import User

router = APIRouter(prefix="/api/discord", tags=["discord"])
API = "https://discord.com/api/v10"
FIELDS = ("app_id", "public_key", "bot_token")
_APP_ID = re.compile(r"\d{17,21}")
_PUBLIC_KEY = re.compile(r"[0-9a-f]{64}")
_TOKEN = re.compile(r"[A-Za-z0-9._-]{50,100}")
COMMAND = {
    "name": "demos", "type": 1, "contexts": [0],
    "description": "Importer dans Sightline des démos FACEIT d'un adversaire",
    "options": [
        {"type": 3, "name": "adversaire", "description": "Équipe adverse (par défaut : notre prochain adversaire FACEIT)",
         "required": False, "max_length": 64},
        {"type": 4, "name": "nombre", "description": "Nombre de démos, de 1 à 5 (2 par défaut)", "required": False,
         "min_value": 1, "max_value": faceit_demos.MAX_ASK},
    ],
}
_tasks: set = set()  # référence gardée : une tâche asyncio sans référence peut être collectée en cours de route


def _conf(settings: Settings) -> dict:
    sec = read_secrets(settings.data_dir)
    return {k: sec.get(f"discord_{k}") or "" for k in FIELDS}


def _status(settings: Settings, db: Session) -> dict:
    c = _conf(settings)
    return {"app_id": c["app_id"], "public_key": c["public_key"], "has_token": bool(c["bot_token"]),
            "endpoint": f"{(settings.public_url or '').rstrip('/')}/api/discord/interactions",
            "invite": f"https://discord.com/oauth2/authorize?client_id={c['app_id']}&scope=applications.commands"
                      if c["app_id"] else None,
            "queue": faceit_demos.queue(db), "disk_free": faceit_demos.disk_free(settings.data_dir)}


@router.get("/config")
def get_config(settings: Settings = Depends(get_settings), db: Session = Depends(get_session),
               _: User | None = Depends(require_owner)):
    return _status(settings, db)


@router.put("/config")
def set_config(body: dict = Body(...), settings: Settings = Depends(get_settings), db: Session = Depends(get_session),
               _: User | None = Depends(require_owner)):
    """{app_id, public_key, bot_token?} : enregistre l'application puis la commande /demos (avec le jeton du bot)."""
    app_id = str(body.get("app_id") or "").strip()
    public_key = str(body.get("public_key") or "").strip().lower()
    token = str(body.get("bot_token") or "").strip()
    if not _APP_ID.fullmatch(app_id):
        raise HTTPException(400, "ID de l'application invalide (« Application ID », 17 à 21 chiffres)")
    if not _PUBLIC_KEY.fullmatch(public_key):
        raise HTTPException(400, "Clé publique invalide (« Public Key », 64 caractères 0-9 et a-f)")
    if token and not _TOKEN.fullmatch(token):
        raise HTTPException(400, "Jeton du bot invalide (onglet Bot › Reset Token)")
    sec = read_secrets(settings.data_dir)
    sec.update({"discord_app_id": app_id, "discord_public_key": public_key})
    if token:
        sec["discord_bot_token"] = token
    write_secrets(settings.data_dir, sec)
    token = sec.get("discord_bot_token") or ""
    registered, error = False, None
    if token:
        try:
            r = httpx.put(f"{API}/applications/{app_id}/commands", headers={"Authorization": f"Bot {token}"},
                          json=[COMMAND], timeout=15)
            registered = r.status_code == 200
            if not registered:
                error = "Jeton du bot refusé par Discord" if r.status_code in (401, 403) else f"Discord a répondu {r.status_code}"
        except httpx.HTTPError as e:
            error = f"Discord injoignable : {e}"
    return {**_status(settings, db), "registered": registered, "error": error}


def _verified(public_key: str, signature: str, timestamp: str, body: bytes) -> bool:
    try:
        if abs(time.time() - int(timestamp)) > 300:  # requête rejouée
            return False
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key)).verify(bytes.fromhex(signature), timestamp.encode() + body)
        return True
    except (ValueError, TypeError, InvalidSignature):
        return False


@router.post("/interactions")
async def interactions(request: Request, settings: Settings = Depends(get_settings)):
    """Appelée par Discord (route publique : seule la signature fait foi)."""
    conf = _conf(settings)
    body = await request.body()
    if not conf["public_key"] or not _verified(conf["public_key"], request.headers.get("x-signature-ed25519", ""),
                                               request.headers.get("x-signature-timestamp", ""), body):
        raise HTTPException(401, "Signature Discord invalide")
    data = json.loads(body)
    if data.get("type") == 1:  # PING : vérification de l'adresse par Discord
        return {"type": 1}
    if data.get("type") == 2 and (data.get("data") or {}).get("name") == "demos":
        opts = {o.get("name"): o.get("value") for o in (data["data"].get("options") or [])}
        user = (data.get("member") or {}).get("user") or data.get("user") or {}
        n = opts.get("nombre")
        n = n if isinstance(n, int) and 1 <= n <= faceit_demos.MAX_ASK else faceit_demos.AUTO
        task = asyncio.create_task(_answer(request.app, settings, data.get("application_id") or conf["app_id"],
                                           str(data.get("token") or ""), str(opts.get("adversaire") or "").strip(), n,
                                           user.get("global_name") or user.get("username") or ""))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
        return {"type": 5}  # « Sightline réfléchit… », complété par _answer
    return {"type": 4, "data": {"content": "Commande inconnue.", "flags": 64}}


async def _answer(app, settings: Settings, app_id: str, token: str, name: str, n: int, by: str) -> None:
    try:
        text = await asyncio.to_thread(ask, app.state.session_factory, settings, app.state.maps, name, n, by)
    except Exception as e:  # noqa: BLE001 — le message Discord ne doit jamais rester sur « réfléchit… »
        text = f"⚠️ Erreur : {e}"
    await followup(app_id, token, text)


async def followup(app_id: str, token: str, text: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=15) as h:
            await h.patch(f"{API}/webhooks/{app_id}/{token}/messages/@original",
                          json={"content": text[:1900], "allowed_mentions": {"parse": []}})
    except httpx.HTTPError:
        pass


def ask(sf: sessionmaker[Session], settings: Settings, maps: dict[str, MapMeta], name: str, n: int, by: str,
        now: datetime | None = None) -> str:
    """Choisit et met en file `n` démos ESEA de l'adversaire ; renvoie le message Discord."""
    key, _ = api_key(settings.data_dir)
    if not key:
        return "⚠️ Clé d'API FACEIT manquante : un administrateur doit l'ajouter dans Sightline."
    free = faceit_demos.disk_free(settings.data_dir)
    if free < faceit_demos.LOW_DISK:
        return f"⚠️ Plus que {free / 1e9:.1f} Go libres sur le serveur : pas de nouvel import pour l'instant."
    c = FaceitClient(key, settings.cache_dir / "faceit-agenda")
    try:
        with sf() as db:
            team, prefer = faceit_demos.resolve(db, c, name, now or utcnow())
            if team is None:
                return f"Je ne trouve pas « {name} » sur FACEIT." if name else \
                    "Aucun match FACEIT à venir : précise l'adversaire, par exemple `/demos adversaire:mskLANERS`."
            fiche = faceit_demos.overview(c, team["team_id"], maps)
            picked = faceit_demos.choose(db, fiche, n, prefer)
            them = fiche["team"]["name"]
            if not picked:
                return f"Rien de nouveau pour **{them}** : leurs démos ESEA sont déjà dans Sightline ou en file."
            faceit_demos.enqueue(db, fiche["team"], picked, "discord", by)
    except FaceitError as e:
        return f"⚠️ FACEIT : {e}"
    finally:
        c.close()
    shown = {m.name: m.display_name for m in maps.values()}
    count = sum(len(m["pick"]) for m in picked)  # une démo par carte : un BO3 en compte jusqu'à 3
    lines = [f"📥 **{count} démo{'s' if count > 1 else ''} de {them}** en file" + (f" (demandé par {by})" if by else "") + " :"]
    for m in picked:
        day = f"{m['started_at'][8:10]}/{m['started_at'][5:7]}" if m.get("started_at") else "?"
        played = ", ".join(shown.get(x["map"], x["map"]) + (f" {x['score'][0]}–{x['score'][1]}" if x.get("score") else "")
                           for x in (m["maps"][k - 1] for k in m["pick"]))
        lines.append(f"• {day} · {played} contre {m.get('opponent', {}).get('name') or '?'}")
    if count < n:
        lines.append(f"({n - count} de moins que demandé : pas d'autre démo ESEA disponible.)")
    lines.append("Un PC avec Chrome connecté à FACEIT (extension Sightline) les récupère dans les 5 min ; "
                 "chaque démo s'annonce ici une fois analysée.")
    return "\n".join(lines)
