# backend/app/api/auth.py
import hmac
import json
import re
import secrets
from datetime import timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.auth.core import (COOKIE, ROLES, LoginLimiter, clean_comparison, create_session, current_user, has_users, hash_password, is_local,
                           request_token, require_admin, require_user, set_cookie, token_hash, user_dict, utcnow,
                           verify_password)
from app.storage.models import AuthSession, Invite, User

router = APIRouter(tags=["auth"])
_limiter = LoginLimiter()
_USERNAME = re.compile(r"^[a-zA-Z0-9_.-]{3,32}$")
INVITE_DAYS = 7


def _check_new(db: Session, username: str, display_name: str, password: str) -> None:
    if not _USERNAME.match(username):
        raise HTTPException(400, "Identifiant : 3 à 32 caractères (lettres, chiffres, . _ -)")
    if not display_name.strip() or len(display_name) > 64:
        raise HTTPException(400, "Nom affiché requis (64 caractères max.)")
    if len(password) < 8:
        raise HTTPException(400, "Mot de passe : 8 caractères minimum")
    if db.scalar(select(User).where(func.lower(User.username) == username.lower())):
        raise HTTPException(409, "Cet identifiant est déjà pris")


def _fields(body: dict) -> tuple[str, str, str]:
    return str(body.get("username", "")).strip(), str(body.get("display_name", "")).strip(), str(body.get("password", ""))


def _login_response(request: Request, response: Response, db: Session, u: User) -> dict:
    set_cookie(response, request, create_session(db, u))
    return {"user": user_dict(u), "setup_required": False}


@router.get("/api/auth/me")
def me(request: Request, user: User | None = Depends(current_user), db: Session = Depends(get_session)):
    setup = not has_users(db)
    return {"user": user_dict(user) if user else None, "setup_required": setup,
            "setup_code_required": setup and not is_local(request)}


@router.post("/api/auth/setup")
def setup(request: Request, response: Response, body: dict = Body(...), db: Session = Depends(get_session)):
    """Création du compte propriétaire, possible uniquement tant qu'aucun compte n'existe."""
    if has_users(db):
        raise HTTPException(409, "L'équipe a déjà un propriétaire")
    if not is_local(request):
        _limiter.check(_client_ip(request))
        code = request.app.state.setup_code or ""
        if not code or not hmac.compare_digest(str(body.get("setup_code", "")).strip().upper(), code):
            raise HTTPException(403, "Code d'installation incorrect : il est écrit dans les logs du serveur au démarrage")
    username, name, pwd = _fields(body)
    _check_new(db, username, name, pwd)
    u = User(username=username, display_name=name, password_hash=hash_password(pwd), role="owner")
    db.add(u)
    db.commit()
    request.app.state.setup_code = None
    return _login_response(request, response, db, u)


def _client_ip(request: Request) -> str:
    return request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()


def _authenticate(request: Request, db: Session, body: dict) -> User:
    _limiter.check(_client_ip(request))
    u = db.scalar(select(User).where(func.lower(User.username) == str(body.get("username", "")).strip().lower()))
    if u is None or not verify_password(str(body.get("password", "")), u.password_hash):
        raise HTTPException(401, "Identifiant ou mot de passe incorrect")
    return u


@router.post("/api/auth/login")
def login(request: Request, response: Response, body: dict = Body(...), db: Session = Depends(get_session)):
    return _login_response(request, response, db, _authenticate(request, db, body))


@router.post("/api/auth/token")
def token(request: Request, body: dict = Body(...), db: Session = Depends(get_session)):
    """Connexion de l'app mobile native : le jeton est rendu dans la réponse (pas de cookie), à renvoyer en Bearer."""
    u = _authenticate(request, db, body)
    return {"token": create_session(db, u), "user": user_dict(u)}


@router.post("/api/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_session)):
    tok = request_token(request)
    if tok:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == token_hash(tok)))
        db.commit()
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.patch("/api/auth/me")
def update_me(request: Request, body: dict = Body(...), user: User | None = Depends(require_user),
              db: Session = Depends(get_session)):
    if user is None:
        raise HTTPException(400, "Aucun compte en mode ouvert")
    u = db.get(User, user.id)
    if "display_name" in body:
        name = str(body["display_name"]).strip()
        if not name or len(name) > 64:
            raise HTTPException(400, "Nom affiché requis (64 caractères max.)")
        u.display_name = name
    if "steamid" in body:
        sid = str(body["steamid"] or "").strip()
        if sid and not sid.isdigit():
            raise HTTPException(400, "SteamID invalide")
        u.steamid = sid or None
    if "ts_nickname" in body:
        nick = str(body["ts_nickname"] or "").strip()
        if len(nick) > 64:
            raise HTTPException(400, "Pseudo TeamSpeak : 64 caractères au plus")
        u.ts_nickname = nick or None
    if "comparison" in body:
        u.comparison = json.dumps(clean_comparison(body["comparison"])) if body["comparison"] else None
    if "new_password" in body:
        if not verify_password(str(body.get("current_password", "")), u.password_hash):
            raise HTTPException(403, "Mot de passe actuel incorrect")
        if len(str(body["new_password"])) < 8:
            raise HTTPException(400, "Mot de passe : 8 caractères minimum")
        u.password_hash = hash_password(str(body["new_password"]))
        # mot de passe compromis : les autres appareils sont déconnectés, celui-ci reste connecté
        db.execute(delete(AuthSession).where(AuthSession.user_id == u.id,
                                             AuthSession.token_hash != token_hash(request.cookies.get(COOKIE, ""))))
    db.commit()
    return user_dict(u)


# ------------------------------------------------------------------------------------------------- invitations
@router.get("/api/auth/invite/{token}")
def invite_info(token: str, db: Session = Depends(get_session)):
    inv = db.scalar(select(Invite).where(Invite.token_hash == token_hash(token)))
    ok = inv is not None and inv.used_by is None and inv.expires_at > utcnow()
    return {"valid": ok, "role": inv.role if ok else None}


@router.post("/api/auth/register")
def register(request: Request, response: Response, body: dict = Body(...), db: Session = Depends(get_session)):
    inv = db.scalar(select(Invite).where(Invite.token_hash == token_hash(str(body.get("token", "")))))
    if inv is None or inv.used_by is not None or inv.expires_at <= utcnow():
        raise HTTPException(410, "Invitation invalide ou expirée")
    username, name, pwd = _fields(body)
    _check_new(db, username, name, pwd)
    u = User(username=username, display_name=name, password_hash=hash_password(pwd), role=inv.role)
    db.add(u)
    db.flush()
    inv.used_by = u.id
    db.commit()
    return _login_response(request, response, db, u)


# ------------------------------------------------------------------------------------------------------ équipe
@router.get("/api/team/members")
def members(_: User | None = Depends(require_user), db: Session = Depends(get_session)):
    order = {r: k for k, r in enumerate(ROLES)}
    return sorted((user_dict(u) for u in db.scalars(select(User))),
                  key=lambda u: (order[u["role"]], u["display_name"].lower()))


def _owners(db: Session) -> int:
    return db.scalar(select(func.count(User.id)).where(User.role == "owner")) or 0


@router.patch("/api/team/members/{uid}")
def set_role(uid: int, body: dict = Body(...), me_: User | None = Depends(require_admin),
             db: Session = Depends(get_session)):
    u = db.get(User, uid)
    role = body.get("role")
    if u is None:
        raise HTTPException(404, "Membre introuvable")
    if role not in ROLES:
        raise HTTPException(400, "Rôle invalide")
    if me_ is not None and me_.role != "owner" and "owner" in (role, u.role):
        raise HTTPException(403, "Seul un propriétaire peut gérer les propriétaires")
    if u.role == "owner" and role != "owner" and _owners(db) <= 1:
        raise HTTPException(409, "L'équipe doit garder au moins un propriétaire")
    u.role = role
    db.commit()
    return user_dict(u)


@router.delete("/api/team/members/{uid}")
def remove_member(uid: int, me_: User | None = Depends(require_admin), db: Session = Depends(get_session)):
    u = db.get(User, uid)
    if u is None:
        raise HTTPException(404, "Membre introuvable")
    if u.role == "owner" and (me_ is None or me_.role != "owner" or _owners(db) <= 1):
        raise HTTPException(409, "Impossible de retirer ce propriétaire")
    db.execute(delete(AuthSession).where(AuthSession.user_id == u.id))  # sans attendre la cascade SQLite
    db.delete(u)
    db.commit()
    return {"ok": True}


@router.get("/api/team/invites")
def invites(_: User | None = Depends(require_admin), db: Session = Depends(get_session)):
    now = utcnow()
    q = select(Invite).where(Invite.used_by.is_(None), Invite.expires_at > now).order_by(Invite.id.desc())
    return [{"id": i.id, "role": i.role, "expires_at": i.expires_at.isoformat(),
             "created_at": i.created_at.isoformat() if i.created_at else None} for i in db.scalars(q)]


@router.post("/api/team/invites")
def create_invite(body: dict = Body(default={}), me_: User | None = Depends(require_admin),
                  db: Session = Depends(get_session)):
    role = body.get("role", "member")
    if role not in ("admin", "member"):
        raise HTTPException(400, "Rôle invalide")
    if not has_users(db):
        raise HTTPException(409, "Créez d'abord le compte propriétaire")
    token = secrets.token_urlsafe(24)
    inv = Invite(token_hash=token_hash(token), role=role, created_by=me_.id if me_ else None,
                 expires_at=utcnow() + timedelta(days=INVITE_DAYS))
    db.add(inv)
    db.commit()
    return {"id": inv.id, "role": role, "token": token, "path": f"/invite/{token}", "expires_at": inv.expires_at.isoformat()}


@router.delete("/api/team/invites/{iid}")
def revoke_invite(iid: int, _: User | None = Depends(require_admin), db: Session = Depends(get_session)):
    inv = db.get(Invite, iid)
    if inv is None:
        raise HTTPException(404, "Invitation introuvable")
    db.delete(inv)
    db.commit()
    return {"ok": True}
