"""Clés d'API des outils externes (n8n…) : `sl_` + 32 octets aléatoires, montrées une seule fois, stockées en SHA-256.
Une clé ne donne aucun droit de compte : seulement les routes de ses droits.
- `import` : POST /api/integrations/import et /api/integrations/known ;
- `comms` : POST /api/integrations/comms (plugin TeamSpeak) ;
- `read` : GET sous /api/matches, /api/players et /api/teams (jamais les réglages, qui contiennent le webhook Discord)."""
from __future__ import annotations

import hashlib
import json
import secrets
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.integrations import iso, utcnow
from app.storage.models import ApiKey

PREFIX = "sl_"
SCOPES = ("import", "read", "comms")
COMMS_ROUTES = ("/api/integrations/comms",)
IMPORT_ROUTES = ("/api/integrations/import", "/api/integrations/known", "/api/integrations/upload",
                 "/api/integrations/calendar", "/api/integrations/upcoming", "/api/integrations/faceit-calendar",
                 "/api/integrations/faceit-wanted", "/api/integrations/faceit-links")
READ_PREFIXES = ("/api/matches", "/api/players", "/api/teams")
TOUCH_EVERY = timedelta(minutes=1)


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def clean_scopes(raw) -> list[str]:
    if not isinstance(raw, list) or not raw or any(s not in SCOPES for s in raw):
        raise ValueError("Droits de la clé : « import », « read » et/ou « comms »")
    return sorted(set(raw))


def create(db: Session, name: str, scopes: list[str], user_id: int | None) -> tuple[ApiKey, str]:
    """Nouvelle clé : la ligne (sans la clé) et la clé en clair, à montrer une seule fois."""
    key = PREFIX + secrets.token_urlsafe(32)
    row = ApiKey(name=name, prefix=key[:8], key_hash=key_hash(key), scopes=json.dumps(scopes), created_by=user_id)
    db.add(row)
    db.commit()
    return row, key


def lookup(db: Session, token: str | None) -> ApiKey | None:
    """Clé active correspondant au jeton ; note la dernière utilisation (une écriture par minute au plus)."""
    if not token or not token.startswith(PREFIX):
        return None
    row = db.scalar(select(ApiKey).where(ApiKey.key_hash == key_hash(token)))
    if row is None or row.revoked_at is not None:
        return None
    now = utcnow()
    if row.last_used_at is None or now - row.last_used_at >= TOUCH_EVERY:
        try:
            row.last_used_at = now
            db.commit()
        except Exception:  # noqa: BLE001 — la date de dernière utilisation ne doit jamais faire échouer l'authentification
            db.rollback()
    return row


def scopes_of(row: ApiKey) -> list[str]:
    return json.loads(row.scopes or "[]")


def allows(scopes: list[str], method: str, path: str) -> bool:
    if "comms" in scopes and method == "POST" and path in COMMS_ROUTES:
        return True
    if "import" in scopes and method == "POST" and path in IMPORT_ROUTES:
        return True
    return "read" in scopes and method == "GET" and any(path == p or path.startswith(p + "/") for p in READ_PREFIXES)


def as_dict(row: ApiKey) -> dict:
    return {"id": row.id, "name": row.name, "prefix": row.prefix, "scopes": scopes_of(row),
            "created_at": iso(row.created_at), "last_used_at": iso(row.last_used_at), "revoked": row.revoked_at is not None}
