# backend/app/api/integrations.py
"""Intégrations (spec 2026-10-22-n8n-webhooks) : clés d'API des outils externes, import de démos par identifiant
externe, webhooks sortants. La gestion est réservée au propriétaire et aux admins ; l'import, aux clés « import »."""
import asyncio
import json
import secrets
import shutil
from datetime import date, datetime
from pathlib import Path

from fastapi import APIRouter, Body, Depends, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.demos import start_download
from app.api.deps import get_service, get_session, get_settings
from app.auth.core import require_owner, require_user
from app.core.config import Settings
from app.faceit import scout
from app.faceit.client import FaceitClient, FaceitError, api_key
from app.ingest import remote
from app.ingest.files import DEMO_EXTENSIONS, sha256_file
from app.ingest.service import ImportService
from app.integrations import agenda, comms, faceit_agenda, faceit_demos, keys, map_odds, sources, utcnow, webhooks
from app.integrations.ours import linked_steamids
from app.storage.models import ApiKey, CommsSession, User, Webhook, WebhookDelivery

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


def require_key(scope: str):
    """Dépendance : requête faite avec une clé d'API qui a ce droit (posée par l'AuthGuard), sinon 403."""
    def dep(request: Request) -> dict:
        key = getattr(request.state, "api_key", None)
        if not key or scope not in key["scopes"]:
            raise HTTPException(403, f"Réservé aux clés d'API qui ont le droit « {scope} »")
        return key
    return dep


@router.get("/keys")
def list_keys(_: User | None = Depends(require_owner), db: Session = Depends(get_session)):
    return [keys.as_dict(k) for k in db.scalars(select(ApiKey).order_by(ApiKey.id.desc()))]


@router.post("/keys")
def create_key(body: dict = Body(...), user: User | None = Depends(require_owner), db: Session = Depends(get_session)):
    name = str(body.get("name") or "").strip()
    if not 1 <= len(name) <= 64:
        raise HTTPException(400, "Nom de la clé : 1 à 64 caractères")
    try:
        scopes = keys.clean_scopes(body.get("scopes"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    row, key = keys.create(db, name, scopes, user.id if user else None)
    return {**keys.as_dict(row), "key": key}


@router.delete("/keys/{key_id}")
def revoke_key(key_id: int, _: User | None = Depends(require_owner), db: Session = Depends(get_session)):
    row = db.get(ApiKey, key_id)
    if row is None:
        raise HTTPException(404, "Clé inconnue")
    if row.revoked_at is None:
        row.revoked_at = utcnow()
        db.commit()
    return keys.as_dict(row)


@router.post("/known")
def known_demos(body: dict = Body(...), _key: dict = Depends(require_key("import")), db: Session = Depends(get_session)):
    """Parmi ces identifiants, ceux que Sightline a déjà (importés, en cours ou abandonnés)."""
    source, ids = body.get("source"), body.get("ids")
    if source not in sources.SOURCES:
        raise HTTPException(400, "Source inconnue : pracc, faceit ou url")
    if not isinstance(ids, list) or len(ids) > 500 or not all(isinstance(i, str) and 0 < len(i) <= 128 for i in ids):
        raise HTTPException(400, "Identifiants : une liste de 500 au plus")
    return {"known": sources.known(db, source, ids)}


@router.post("/import")
async def import_demo(body: dict = Body(...), _key: dict = Depends(require_key("import")),
                      svc: ImportService = Depends(get_service), settings: Settings = Depends(get_settings),
                      db: Session = Depends(get_session)):
    """Importe une démo repérée par son identifiant chez la source ; « known » sans rien télécharger si elle est déjà là."""
    source = body.get("source")
    external_id = str(body.get("external_id") or "").strip()
    url = str(body.get("url") or "").strip()
    if source not in sources.SOURCES:
        raise HTTPException(400, "Source inconnue : pracc, faceit ou url")
    if not 0 < len(external_id) <= 128:
        raise HTTPException(400, "Identifiant chez la source requis (128 caractères au plus)")
    try:
        label = sources.clean_label(body.get("label"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    row = sources.find(db, source, external_id)
    if row is not None and row.status in sources.KNOWN:
        return {"status": "known", "demo_id": row.demo_id, "source_id": row.id}
    try:
        await asyncio.to_thread(remote.check_url, url)
    except remote.RemoteError as e:
        raise HTTPException(400, str(e))
    row = sources.start(db, source, external_id, label)
    origin = {"source_id": row.id, "source": source, "external_id": external_id, "opponent": label.get("opponent") or None}
    dl = start_download(remote.Download(id=secrets.token_hex(6), url=url), svc, settings, origin=origin)
    return {"status": "started", "source_id": row.id, "download": dl}


def _save_upload(src, dest: Path) -> None:
    with open(dest, "wb") as out:
        shutil.copyfileobj(src, out, 8 * 1024 * 1024)


@router.post("/upload")
async def upload_demo(file: UploadFile, opponent: str = Form(""), _key: dict = Depends(require_key("import")),
                      svc: ImportService = Depends(get_service), settings: Settings = Depends(get_settings),
                      db: Session = Depends(get_session)):
    """Démo envoyée par le formulaire d'import de n8n : même suivi qu'un prac PRACC (étiquette, pas de doublon, annonces
    Discord), repérée par l'empreinte du fichier. L'import est fini à la réponse ; l'analyse suit en arrière-plan."""
    name = Path(file.filename or "demo.dem").name
    if not name.lower().endswith(DEMO_EXTENSIONS):
        raise HTTPException(400, f"Format non supporté : {name} (attendu .dem ou .dem.bz2)")
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    dest = settings.uploads_dir / f"formulaire-{secrets.token_hex(4)}-{name}"
    await asyncio.to_thread(_save_upload, file.file, dest)
    digest = await asyncio.to_thread(sha256_file, dest)
    row = sources.find(db, "form", digest)
    if row is not None and row.status in sources.KNOWN:
        dest.unlink(missing_ok=True)
        return {"status": "known", "demo_id": row.demo_id}
    opponent = opponent.strip()[:64]
    label = sources.clean_label({"folder": "Formulaire", "played_on": date.today().isoformat(),
                                 "tags": ["formulaire", opponent] if opponent else ["formulaire"], "opponent": opponent})
    row = sources.start(db, "form", digest, label)
    origin = {"source_id": row.id, "source": "form", "external_id": digest[:12], "opponent": opponent or None}
    try:
        res = await svc.import_paths([dest], origin=origin)
    except Exception as e:  # noqa: BLE001 — la demande garde l'échec, n8n l'affiche dans le formulaire
        await asyncio.to_thread(sources.mark_failed, svc.sf, row.id, str(e))
        raise HTTPException(500, f"Import impossible : {e}") from e
    await asyncio.to_thread(sources.mark_done, svc.sf, row.id, res[0]["demo_id"], res[0]["created"])
    if not res[0]["created"]:
        dest.unlink(missing_ok=True)  # déjà dans la bibliothèque (déposée sur le site) : la copie ne sert à rien
    return {"status": "imported" if res[0]["created"] else "known", "demo_id": res[0]["demo_id"]}


@router.post("/calendar")
def sync_calendar(body: dict = Body(...), _key: dict = Depends(require_key("import")), db: Session = Depends(get_session)):
    """Calendrier d'une source (PRACC, lu par l'extension et trié par n8n) : remplace ses événements à venir."""
    source, events = body.get("source"), body.get("events")
    if source not in sources.SOURCES:
        raise HTTPException(400, "Source inconnue : pracc, faceit ou url")
    if not isinstance(events, list):
        raise HTTPException(400, "events : une liste d'événements")
    return agenda.sync(db, source, events, utcnow())


@router.post("/faceit-calendar")
def faceit_calendar(request: Request, _key: dict = Depends(require_key("import")), settings: Settings = Depends(get_settings),
                    db: Session = Depends(get_session)):
    """Nos matchs FACEIT à venir (ESEA…), lus depuis le serveur et mis au calendrier, avec leurs cartes probables, et 2
    démos de chaque nouvel adversaire mises en file pour l'extension (n8n W6, toutes les 15 min). Une erreur de FACEIT,
    ou une équipe introuvable, laisse le calendrier tel quel."""
    key, _ = api_key(settings.data_dir)
    if not key:
        raise HTTPException(409, "Clé d'API FACEIT manquante : un administrateur doit l'ajouter (Scouting › FACEIT)")
    c = FaceitClient(key, settings.cache_dir / "faceit-agenda")  # à part : le scouting garde les matchs finis à vie
    try:
        found = faceit_agenda.upcoming(c, linked_steamids(db))
        if found["events"] is None:
            return {"team": found["team"], "created": 0, "updated": 0, "removed": 0, "moved": [], "queued": 0}
        res = agenda.sync(db, "faceit", found["events"], utcnow())
        map_odds.refresh(db, c, found, request.app.state.maps, utcnow())
        res["queued"] = faceit_demos.auto(db, c, found, request.app.state.maps, utcnow(),
                                          faceit_demos.disk_free(settings.data_dir))
    except FaceitError as e:
        raise HTTPException(502 if e.status == 404 else e.status, str(e)) from e
    finally:
        c.close()
    return {"team": found["team"], **res}


@router.post("/faceit-wanted")
def faceit_wanted(_key: dict = Depends(require_key("import")), settings: Settings = Depends(get_settings),
                  db: Session = Depends(get_session)):
    """Démos FACEIT à récupérer, confiées à l'extension qui demande (via n8n W1) : la page du match à ouvrir sur
    faceit.com. Rien sous 3 Go libres."""
    if faceit_demos.disk_free(settings.data_dir) < faceit_demos.LOW_DISK:
        return {"wanted": [], "low_disk": True}
    return {"wanted": faceit_demos.take(db, utcnow())}


@router.post("/faceit-links")
async def faceit_links(body: dict = Body(...), _key: dict = Depends(require_key("import")),
                       svc: ImportService = Depends(get_service), settings: Settings = Depends(get_settings),
                       db: Session = Depends(get_session)):
    """Liens signés relevés par l'extension sur la page d'un match FACEIT ({match_id, links} ou {match_id, error}) :
    Sightline télécharge les démos lui-même. « login » : l'extension n'est pas connectée à FACEIT, la demande attend."""
    match_id = str(body.get("match_id") or "")
    if not scout.MATCH_ID.fullmatch(match_id):
        raise HTTPException(400, "Identifiant de match FACEIT invalide")
    row = sources.find(db, faceit_demos.SOURCE, match_id)
    if row is None or row.status != faceit_demos.PICKED:
        return {"status": "ignored"}
    error = str(body.get("error") or "")[:200]
    if error == "login":
        row.status = faceit_demos.WANTED
        db.commit()
        return {"status": "login"}
    links = []
    for u in [u for u in body.get("links") or [] if isinstance(u, str)][:5]:
        try:
            await asyncio.to_thread(remote.check_url, u)
        except remote.RemoteError:
            continue
        if ".dem" in u.split("?")[0]:
            links.append(u)
    links = faceit_demos.keep(links, match_id, json.loads(row.label or "{}"))  # BO3 : les cartes demandées seulement
    if not links:
        faceit_demos.failed(db, row, error or "Aucun lien de démo sur la page du match")
        return {"status": "failed"}
    row.status = "downloading"
    db.commit()
    origin = {"source_id": row.id, "source": faceit_demos.SOURCE, "external_id": match_id, "opponent": None}
    for u in links:
        start_download(remote.Download(id=secrets.token_hex(6), url=u, faceit_match=match_id), svc, settings, origin=origin)
    return {"status": "started", "count": len(links)}


@router.post("/upcoming")
def upcoming_events(request: Request, body: dict = Body(default={}), _key: dict = Depends(require_key("import")),
                    settings: Settings = Depends(get_settings), db: Session = Depends(get_session)):
    """Matchs à venir dans les prochaines heures (24 par défaut), chacun rendu une seule fois, avec la prép (n8n W5)."""
    hours = body.get("hours", 24)
    if not isinstance(hours, int) or not 1 <= hours <= 72:
        raise HTTPException(400, "hours : de 1 à 72")
    base = (settings.public_url or "").rstrip("/")
    return {"events": agenda.claim_upcoming(db, request.app.state.maps, hours, utcnow(), base)}


def _webhook(db: Session, webhook_id: int) -> Webhook:
    h = db.get(Webhook, webhook_id)
    if h is None:
        raise HTTPException(404, "Webhook inconnu")
    return h


@router.get("/webhooks")
def list_webhooks(_: User | None = Depends(require_owner), db: Session = Depends(get_session)):
    return [webhooks.as_dict(h) for h in db.scalars(select(Webhook).order_by(Webhook.id))]


@router.post("/webhooks")
async def create_webhook(body: dict = Body(...), user: User | None = Depends(require_owner),
                         db: Session = Depends(get_session)):
    """Nouveau webhook ; son secret n'est montré qu'ici."""
    try:
        url = await asyncio.to_thread(webhooks.check_url, str(body.get("url") or ""))
        events = webhooks.clean_events(body.get("events"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    secret = webhooks.new_secret()
    h = Webhook(url=url, secret=secret, events=json.dumps(events), active=True, created_by=user.id if user else None)
    db.add(h)
    db.commit()
    return {**webhooks.as_dict(h), "secret": secret}


@router.patch("/webhooks/{webhook_id}")
def update_webhook(webhook_id: int, body: dict = Body(...), _: User | None = Depends(require_owner),
                   db: Session = Depends(get_session)):
    h = _webhook(db, webhook_id)
    if "active" in body:
        h.active = bool(body["active"])
    if "events" in body:
        try:
            h.events = json.dumps(webhooks.clean_events(body["events"]))
        except ValueError as e:
            raise HTTPException(400, str(e))
    db.commit()
    return webhooks.as_dict(h)


@router.delete("/webhooks/{webhook_id}")
def delete_webhook(webhook_id: int, _: User | None = Depends(require_owner), db: Session = Depends(get_session)):
    db.delete(_webhook(db, webhook_id))
    db.commit()
    return {"ok": True}


@router.post("/webhooks/{webhook_id}/test")
def test_webhook(request: Request, webhook_id: int, _: User | None = Depends(require_owner),
                 db: Session = Depends(get_session)):
    webhooks.ping(request.app.state.session_factory, _webhook(db, webhook_id))
    return {"ok": True}


@router.get("/webhooks/deliveries")
def list_deliveries(limit: int = 20, _: User | None = Depends(require_owner), db: Session = Depends(get_session)):
    q = select(WebhookDelivery).order_by(WebhookDelivery.id.desc()).limit(max(1, min(limit, 50)))
    return [webhooks.delivery_dict(d) for d in db.scalars(q)]


PLUGIN_FILE = "sightline-comms.ts3_plugin"


@router.post("/comms")
async def receive_comms(request: Request, _key: dict = Depends(require_key("comms")),
                        settings: Settings = Depends(get_settings), db: Session = Depends(get_session)):
    """Comms TeamSpeak d'une map (plugin Sightline) : `session` (JSON) et une piste Opus par voix. Rattachées tout de
    suite si la démo est là, sinon à son import (48 h au plus)."""
    if int(request.headers.get("content-length") or 0) > comms.MAX_BYTES + comms.MULTIPART_SLACK:
        raise HTTPException(413, f"Session trop lourde ({comms.MAX_BYTES // (1024 * 1024)} Mo au plus)")
    form = await request.form()
    try:
        raw = json.loads(str(form.get("session") or ""))
    except ValueError:
        raise HTTPException(400, "session : JSON attendu")
    uploads = [f for f in form.getlist("files") if hasattr(f, "filename")]
    if len(uploads) > comms.MAX_TRACKS:
        raise HTTPException(400, f"{comms.MAX_TRACKS} pistes au plus")
    try:
        s = comms.clean_session(raw, {Path(f.filename or "").name for f in uploads})
    except ValueError as e:
        raise HTTPException(400, str(e))
    folder = settings.data_dir / "comms" / secrets.token_hex(8)
    folder.mkdir(parents=True, exist_ok=True)
    try:
        total = 0
        for f in uploads:
            with open(folder / Path(f.filename).name, "wb") as out:
                while chunk := await f.read(comms.CHUNK):
                    total += len(chunk)
                    if total > comms.MAX_BYTES:
                        raise HTTPException(413, f"Session trop lourde ({comms.MAX_BYTES // (1024 * 1024)} Mo au plus)")
                    out.write(chunk)
        row = CommsSession(status="waiting", recorder_steamid=s["recorder_steamid"], map_name=s["map"],
                           started_at=datetime.fromisoformat(s["started_at"]),
                           payload=json.dumps(s, ensure_ascii=False), folder=str(folder))
        db.add(row)
        db.commit()
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    await asyncio.to_thread(comms.settle, request.app.state, row.id)
    db.refresh(row)
    return {"status": row.status, "session_id": row.id, "match_id": row.match_id, "offset_s": row.offset_s,
            "tracks": len(s["tracks"])}


@router.get("/comms")
def list_comms(_: User | None = Depends(require_user), settings: Settings = Depends(get_settings),
               db: Session = Depends(get_session)):
    rows = db.scalars(select(CommsSession).order_by(CommsSession.id.desc()).limit(30))
    return {"plugin": (settings.data_dir / "plugins" / PLUGIN_FILE).exists(), "sessions": [comms.as_dict(r) for r in rows]}


@router.get("/comms/plugin")
def comms_plugin(_: User | None = Depends(require_user), settings: Settings = Depends(get_settings)):
    p = settings.data_dir / "plugins" / PLUGIN_FILE
    if not p.exists():
        raise HTTPException(404, "Plugin pas encore publié")
    return FileResponse(p, media_type="application/octet-stream", filename=PLUGIN_FILE)
