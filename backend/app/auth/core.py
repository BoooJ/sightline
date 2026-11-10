# backend/app/auth/core.py
"""Comptes et sessions (sous-projet 7).

- Mots de passe : scrypt (bibliothèque standard), sel aléatoire, comparaison en temps constant.
- Sessions : jeton aléatoire dans un cookie HttpOnly ; seule son empreinte SHA-256 est stockée.
- Tant qu'aucun compte n'existe, l'application reste ouverte pour la machine elle-même (usage local mono-utilisateur)
  et propose de créer le compte propriétaire ; dès qu'il existe, toute l'API exige une session.
- Sur un serveur (requête distante ou passée par un proxy), rien n'est ouvert : la création du compte propriétaire exige
  le code d'installation écrit dans les logs au démarrage, sinon le premier venu prendrait l'équipe."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, Request
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.storage.models import AuthSession, User

# Les cookies ne distinguent pas les ports : deux copies lancées en même temps sur localhost se partageraient la
# session. start.ps1 donne donc à chaque copie son propre nom de cookie.
COOKIE = os.environ.get("SKYBOX_SESSION_COOKIE", "sl_session")
SESSION_DAYS = 30
ROLES = ("owner", "admin", "member")
_N, _R, _P = 2 ** 14, 8, 1


def utcnow() -> datetime:
    """UTC naïf (SQLite ne stocke pas les fuseaux)."""
    return datetime.now(UTC).replace(tzinfo=None)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, dk = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, base64.b64decode(dk))
    except (ValueError, TypeError):
        return False


LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}
PROXY_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded")


def is_local(request: Request) -> bool:
    """Requête de la machine elle-même, sans proxy devant (un proxy local relaie des visiteurs distants)."""
    return (request.client is not None and request.client.host in LOCAL_HOSTS
            and not any(h in request.headers for h in PROXY_HEADERS))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def request_token(request: Request) -> str | None:
    """Jeton de session : en-tête `Authorization: Bearer` (app native), sinon cookie (site, version web)."""
    auth = request.headers.get("authorization", "").strip()
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip() or None
    if auth.startswith("sl_"):  # clé d'API collée seule, sans « Bearer » (identifiant n8n) : vérifiée par son hash
        return auth
    return request.cookies.get(COOKIE)


def has_users(db: Session) -> bool:
    return bool(db.scalar(select(func.count(User.id))))


def create_session(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(32)
    db.execute(delete(AuthSession).where(AuthSession.expires_at < utcnow()))
    db.add(AuthSession(token_hash=token_hash(token), user_id=user.id,
                       expires_at=utcnow() + timedelta(days=SESSION_DAYS)))
    db.commit()
    return token


def user_from_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    s = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash(token)))
    if s is None or s.expires_at < utcnow():
        return None
    return db.get(User, s.user_id)


def set_cookie(response, request: Request, token: str) -> None:
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", secure=secure, path="/")


def current_user(request: Request, db: Session = Depends(get_session)) -> User | None:
    """Utilisateur connecté, ou None en mode ouvert (aucun compte)."""
    return user_from_token(db, request_token(request))


def require_user(request: Request, user: User | None = Depends(current_user),
                 db: Session = Depends(get_session)) -> User | None:
    if user is None and (has_users(db) or not is_local(request)):
        raise HTTPException(401, "Connexion requise")
    return user


def require_admin(user: User | None = Depends(require_user)) -> User | None:
    if user is not None and user.role not in ("owner", "admin"):
        raise HTTPException(403, "Réservé aux administrateurs de l'équipe")
    return user


def require_owner(user: User | None = Depends(require_user)) -> User | None:
    """Clés et secrets (accès API, webhooks, bot Discord, clés IA et FACEIT) : le propriétaire seul."""
    if user is not None and user.role != "owner":
        raise HTTPException(403, "Réservé au propriétaire de l'équipe")
    return user


COMPARISON_MONTHS = (1, 3, 6, 12)


def clean_comparison(raw) -> dict:
    """Valide le réglage de comparaison : {mode: teams|self, teams: [ids ≤ 5], months: 1|3|6|12}."""
    if not isinstance(raw, dict) or raw.get("mode") not in ("teams", "self"):
        raise HTTPException(400, "Réglage de comparaison invalide")
    teams = raw.get("teams") or []
    if not isinstance(teams, list) or not all(isinstance(t, int) for t in teams) or len(teams) > 5:
        raise HTTPException(400, "Équipes de comparaison : 5 identifiants au plus")
    months = raw.get("months", 3)
    if months not in COMPARISON_MONTHS:
        raise HTTPException(400, "Fenêtre de comparaison : 1, 3, 6 ou 12 mois")
    return {"mode": raw["mode"], "teams": teams, "months": months}


def user_dict(u: User) -> dict:
    comparison = None
    if u.comparison:
        try:
            comparison = json.loads(u.comparison)
        except ValueError:
            comparison = None
    return {"id": u.id, "username": u.username, "display_name": u.display_name, "role": u.role, "steamid": u.steamid,
            "ts_nickname": u.ts_nickname,
            "comparison": comparison, "created_at": u.created_at.isoformat() if u.created_at else None}


class LoginLimiter:
    """Limite les tentatives de connexion par adresse (10 par 5 minutes)."""

    def __init__(self, limit: int = 10, window_s: int = 300) -> None:
        self.limit, self.window = limit, window_s
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, key: str) -> None:
        now = time.monotonic()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                raise HTTPException(429, "Trop de tentatives, réessayez dans quelques minutes")
            q.append(now)
