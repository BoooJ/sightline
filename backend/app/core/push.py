# backend/app/core/push.py
"""Notifications web (Web Push + VAPID) de l'app mobile installée sur l'écran d'accueil.

- Clés VAPID créées au premier besoin dans le dossier de données (vapid_private.pem), jamais régénérées : les
  abonnements existants en dépendent.
- Destinataires : « match prêt » → les comptes dont le SteamID a joué le match (message personnalisé) ;
  « rapport de préparation » → tous les comptes. Les autres notifications d'équipe restent dans l'app.
- Envoi dans un fil à part (un service de push lent ne doit jamais bloquer un import) ; abonnements expirés
  (404 / 410) supprimés.
- Le serveur n'envoie qu'aux services de push connus : une adresse d'abonnement arbitraire ferait de lui un relais
  vers n'importe quelle URL (SSRF)."""
from __future__ import annotations

import base64
import json
import logging
import re
import threading
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush
from sqlalchemy import delete, func, select  # noqa: F401  (func : utilisé par les tests)
from sqlalchemy.orm import Session

from app.storage.models import Match, MatchPlayer, PushSubscription, User

log = logging.getLogger(__name__)
RUN_IN_THREAD = True
PUSH_HOSTS = ("fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com")
_lock = threading.Lock()


def allowed_endpoint(url: str) -> bool:
    u = urlparse(url)
    host = (u.hostname or "").lower()
    return u.scheme == "https" and len(url) <= 1024 and any(host == h or host.endswith("." + h) for h in PUSH_HOSTS)


def vapid_keys(data_dir: Path) -> tuple[Path, str]:
    """(fichier PEM de la clé privée, clé publique en base64url pour `applicationServerKey`)."""
    pem = data_dir / "vapid_private.pem"
    with _lock:
        if not pem.exists():
            data_dir.mkdir(parents=True, exist_ok=True)
            key = ec.generate_private_key(ec.SECP256R1())
            pem.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                              serialization.NoEncryption()))
        key = serialization.load_pem_private_key(pem.read_bytes(), password=None)
    raw = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return pem, base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _map_name(name: str) -> str:
    return name.removeprefix("de_").capitalize()


def messages_for(db: Session, kind: str, title: str, body: str, link: str) -> list[tuple[int, dict]]:
    """(compte, message) à envoyer pour une notification d'équipe ; adresses vers l'app (/app/...)."""
    if kind == "match_ready":
        m = re.match(r"^/matches/(\d+)", link or "")
        match = db.get(Match, int(m.group(1))) if m else None
        if match is None:
            return []
        teams = {mp.steamid: mp.team_id for mp in db.scalars(select(MatchPlayer).where(MatchPlayer.match_id == match.id))}
        out = []
        for u in db.scalars(select(User).where(User.steamid.in_(list(teams)))):
            ours = match.team_a_id == teams[u.steamid]
            opp = match.team_b if ours else match.team_a
            s1, s2 = (match.score_a, match.score_b) if ours else (match.score_b, match.score_a)
            out.append((u.id, {"title": f"Ton match contre {opp.name} est analysé",
                               "body": f"{s1}–{s2} sur {_map_name(match.map_name)} · ton bilan est prêt",
                               "url": f"/app/matches/{match.id}", "tag": f"match-{match.id}"}))
        return out
    if kind == "prep_report":
        return [(uid, {"title": title, "body": body, "url": "/app/matches", "tag": "prep"})
                for uid in db.scalars(select(User.id))]
    return []


def _send_all(engine, jobs: list[tuple[int, dict, dict]], pem: str, claims: dict) -> None:
    gone = []
    for sub_id, info, payload in jobs:
        try:
            webpush(subscription_info=info, data=json.dumps(payload, ensure_ascii=False), vapid_private_key=pem,
                    vapid_claims=dict(claims), ttl=24 * 3600)
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):
                gone.append(sub_id)
            else:
                log.warning("notification web refusée (%s) : %s", code, e)
        except Exception as e:  # noqa: BLE001  (réseau : une notification perdue ne doit rien casser)
            log.warning("notification web : %s", e)
    if gone:
        with Session(engine) as s:
            s.execute(delete(PushSubscription).where(PushSubscription.id.in_(gone)))
            s.commit()


def dispatch(db: Session, settings, kind: str, title: str, body: str, link: str) -> None:
    msgs = messages_for(db, kind, title, body, link)
    if not msgs:
        return
    by_user: dict[int, list[dict]] = {}
    for uid, payload in msgs:
        by_user.setdefault(uid, []).append(payload)
    subs = db.scalars(select(PushSubscription).where(PushSubscription.user_id.in_(list(by_user)))).all()
    jobs = [(s.id, {"endpoint": s.endpoint, "keys": {"p256dh": s.p256dh, "auth": s.auth}}, p)
            for s in subs for p in by_user[s.user_id]]
    if not jobs:
        return
    pem, _ = vapid_keys(Path(settings.data_dir))
    public = getattr(settings, "public_url", "") or ""
    claims = {"sub": public if public.startswith("https://") else "mailto:sightline@example.com"}
    args = (db.get_bind(), jobs, str(pem), claims)
    if RUN_IN_THREAD:
        threading.Thread(target=_send_all, args=args, daemon=True).start()
    else:
        _send_all(*args)
