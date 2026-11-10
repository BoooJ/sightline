"""Webhooks sortants : chaque événement (démo importée, match analysé, échec) part en POST JSON vers les URL abonnées,
signé par un JWT HS256 (secret du webhook, valable 5 minutes, empreinte SHA-256 du corps) : le nœud Webhook de n8n
le vérifie lui-même (authentification « JWT Auth »). 3 essais, journal des 200 derniers ; envoi dans un fil à part :
un webhook en panne ne ralentit jamais un import."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
import urllib.parse
import uuid

import httpx
from sqlalchemy import delete, select

from app.ingest import remote
from app.integrations import iso, utcnow
from app.storage.models import Webhook, WebhookDelivery

log = logging.getLogger(__name__)
EVENTS = ("demo.imported", "match.ready", "demo.failed", "comms.ready")
RETRY_DELAYS = (0, 10, 60)  # secondes d'attente avant chaque essai
TOKEN_TTL = 300
KEEP = 200
_threads: set[threading.Thread] = set()
_lock = threading.Lock()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def jwt_hs256(claims: dict, secret: str) -> str:
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps(claims, separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{_b64(sig)}"


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def check_url(url: str) -> str:
    """HTTPS vers une adresse publique : pas d'envoi vers le réseau interne du serveur."""
    url = (url or "").strip()
    p = urllib.parse.urlparse(url)
    if p.scheme != "https" or not p.hostname or len(url) > 512:
        raise ValueError("Adresse du webhook : https://… (512 caractères au plus)")
    try:
        remote._public_host(p.hostname)
    except remote.RemoteError as e:
        raise ValueError(str(e)) from None
    except (UnicodeError, ValueError):  # nom d'hôte mal formé (https://a..b/)
        raise ValueError("Adresse du webhook invalide") from None
    return url


def clean_events(raw) -> list[str]:
    if not isinstance(raw, list) or not raw or any(e not in EVENTS for e in raw):
        raise ValueError("Événements : demo.imported, match.ready et/ou demo.failed")
    return [e for e in EVENTS if e in raw]


def send(url: str, body: bytes, headers: dict) -> int:
    """POST du webhook (remplacé dans les tests). Aucune redirection suivie : l'adresse vérifiée est celle appelée."""
    return httpx.post(url, content=body, headers=headers, timeout=10, follow_redirects=False,
                      trust_env=False).status_code


def deliver(sf, webhook_id: int, url: str, secret: str, event: str, data: dict) -> bool:
    """Envoie l'événement, jusqu'à 3 essais, chacun noté au journal. Vrai si un essai a répondu 2xx."""
    delivery = uuid.uuid4().hex
    body = json.dumps({"id": delivery, "event": event, "created_at": iso(utcnow()), "data": data},
                      separators=(",", ":"), ensure_ascii=False).encode()
    digest = hashlib.sha256(body).hexdigest()
    for attempt, delay in enumerate(RETRY_DELAYS, start=1):
        if delay:
            time.sleep(delay)
        now = int(time.time())
        token = jwt_hs256({"iss": "sightline", "event": event, "delivery": delivery, "body_sha256": digest,
                           "iat": now, "exp": now + TOKEN_TTL}, secret)
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}",
                   "User-Agent": "Sightline-Webhooks/1.0", "X-Sightline-Event": event, "X-Sightline-Delivery": delivery}
        start, code, error = time.monotonic(), None, None
        try:
            check_url(url)  # revérifiée à chaque essai : le nom peut avoir changé de résolution depuis la création
            code = send(url, body, headers)
            if not 200 <= code < 300:
                error = f"HTTP {code}"
        except Exception as e:  # noqa: BLE001 — réseau, DNS, délai : noté, puis nouvel essai
            error = str(e)[:300] or e.__class__.__name__
        _log(sf, webhook_id, event, delivery, attempt, code, error, int((time.monotonic() - start) * 1000))
        if error is None:
            return True
    return False


def _log(sf, webhook_id, event, delivery, attempt, code, error, ms) -> None:
    try:
        with sf() as db:
            db.add(WebhookDelivery(webhook_id=webhook_id, event=event, delivery_id=delivery, attempt=attempt,
                                   status_code=code, error=error, duration_ms=ms))
            db.flush()
            old = db.scalars(select(WebhookDelivery.id).order_by(WebhookDelivery.id.desc()).offset(KEEP)).all()
            if old:
                db.execute(delete(WebhookDelivery).where(WebhookDelivery.id.in_(old)))
            db.commit()
    except Exception as e:  # noqa: BLE001 — webhook supprimé entre-temps, base occupée : le journal n'est pas vital
        log.warning("journal des webhooks : %s", e)


def _run(*args) -> None:
    try:
        deliver(*args)
    except Exception as e:  # noqa: BLE001
        log.warning("webhook : %s", e)
    finally:
        with _lock:
            _threads.discard(threading.current_thread())


def _spawn(*args) -> None:
    t = threading.Thread(target=_run, args=args, daemon=True, name="webhook")
    with _lock:
        _threads.add(t)
    t.start()


def emit(sf, event: str, data: dict) -> int:
    """Envoie l'événement à chaque webhook actif abonné, en arrière-plan. Ne lève jamais : appelé depuis l'import."""
    try:
        with sf() as db:
            hooks = [(h.id, h.url, h.secret) for h in db.scalars(select(Webhook).where(Webhook.active.is_(True)))
                     if event in json.loads(h.events or "[]")]
    except Exception as e:  # noqa: BLE001
        log.warning("webhooks (%s) : %s", event, e)
        return 0
    for hook in hooks:
        _spawn(sf, *hook, event, data)
    return len(hooks)


def ping(sf, hook: Webhook) -> None:
    """Bouton « Envoyer un test » : un événement `ping`, quels que soient les événements choisis."""
    _spawn(sf, hook.id, hook.url, hook.secret, "ping", {"message": "Test depuis Sightline"})


def wait_idle(timeout: float = 10.0) -> bool:
    """Attend la fin des envois en cours (tests)."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        with _lock:
            if not _threads:
                return True
        time.sleep(0.02)
    return False


def as_dict(h: Webhook) -> dict:
    return {"id": h.id, "url": h.url, "events": json.loads(h.events or "[]"), "active": bool(h.active),
            "created_at": iso(h.created_at)}


def delivery_dict(d: WebhookDelivery) -> dict:
    return {"id": d.id, "webhook_id": d.webhook_id, "event": d.event, "delivery_id": d.delivery_id, "attempt": d.attempt,
            "status_code": d.status_code, "error": d.error, "duration_ms": d.duration_ms, "created_at": iso(d.created_at)}
