"""Démos FACEIT d'un adversaire à récupérer : demandées sur Discord (/demos) ou d'office pour chaque nouveau match
FACEIT du calendrier (synchro W6).

Le serveur ne peut pas les télécharger seul : faceit.com le bloque (403 depuis OVH) et l'API Downloads ne nous est pas
accordée. Les demandes attendent donc dans demo_sources (source « faceit », statut « wanted ») qu'une extension Chrome
connectée à FACEIT les prenne (via n8n W1) : sur la page du match, elle récupère le lien signé du bouton « Regarder la
démo », que Sightline télécharge et analyse lui-même."""
from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.api.calendar import _norm
from app.faceit import scout
from app.faceit.client import FaceitClient, FaceitError
from app.integrations import map_odds
from app.integrations.sources import MAX_ATTEMPTS
from app.maps.registry import MapMeta
from app.storage.models import CalendarEvent, DemoSource, FaceitDemo

SOURCE = "faceit"
WANTED, PICKED = "wanted", "picked"
PICK_AGAIN = timedelta(minutes=20)  # prise par un PC qui n'a pas répondu (Chrome fermé entre-temps) : reproposée
PER_TOUR = 3  # matchs confiés à une extension par passage
AUTO = 2  # démos (cartes) demandées d'office pour chaque nouveau match FACEIT
MAX_ASK = 5
LOW_DISK = 3 * 1024 ** 3  # sous 3 Go libres, plus de nouvel import (une démo pèse ~200 Mo)
AHEAD = timedelta(days=14)
FOLDER = "Scouting FACEIT"


def disk_free(data_dir: Path) -> int:
    return shutil.disk_usage(data_dir).free


def _pool(maps: dict[str, MapMeta]) -> tuple[list[str], dict[str, str]]:
    return sorted(m.name for m in maps.values() if m.active_duty), {m.display_name: m.name for m in maps.values()}


def overview(c: FaceitClient, team_id: str, maps: dict[str, MapMeta]) -> dict:
    active, lookup = _pool(maps)
    return scout.team_overview(c, team_id, "esea", map_names=lookup, active_maps=active)


def choose(db: Session, team: dict, n: int, prefer: list[str]) -> list[dict]:
    """Ses `n` démos ESEA à importer (`team` : fiche scout.team_overview), carte par carte : un BO3 a une démo par carte
    jouée. Matchs dont FACEIT propose la démo, ni importés ni déjà demandés ; d'abord ses cartes probables (`prefer`),
    puis les plus récentes. Rend les matchs retenus, chacun avec `pick` : les n° des cartes voulues (1 = première)."""
    taken = set(db.scalars(select(FaceitDemo.match_id))) | set(db.scalars(
        select(DemoSource.external_id).where(DemoSource.source == SOURCE)))
    rank = {m: i for i, m in enumerate(prefer)}
    found = []  # (rang de la carte, ordre du match dans la fiche : le plus récent d'abord, n° de la carte, match)
    for order, m in enumerate(team.get("matches", [])):
        if m["match_id"] in taken:
            continue
        for k, x in enumerate(m.get("maps", [])[:m.get("demos") or 0], start=1):  # une démo par carte, dans l'ordre
            if x.get("map"):
                found.append((rank.get(x["map"], len(rank)), order, k, m))
    found.sort(key=lambda f: f[:3])
    picked: dict[str, dict] = {}
    for _, _, k, m in found[:n]:
        picked.setdefault(m["match_id"], {**m, "pick": []})["pick"].append(k)
    return [{**m, "pick": sorted(m["pick"])} for m in picked.values()]


def enqueue(db: Session, team: dict, matches: list[dict], reason: str, by: str = "") -> None:
    """Demandes en attente d'un PC. L'étiquette (dossier, tags) sera posée sur les démos créées ; `maps` : les cartes
    voulues du match (choose), les autres démos de la page sont ignorées."""
    name = str(team.get("name") or "?")[:64]
    for m in matches:
        row = db.scalar(select(DemoSource).where(DemoSource.source == SOURCE, DemoSource.external_id == m["match_id"]))
        if row is None:
            row = DemoSource(source=SOURCE, external_id=m["match_id"], attempts=0)
            db.add(row)
        label = {"folder": FOLDER, "tags": ["faceit", name], "played_on": (m.get("started_at") or "")[:10] or None,
                 "faceit_team": team.get("team_id"), "reason": reason, "by": by[:64]}
        if m.get("pick"):
            label["maps"] = m["pick"]
        row.status, row.error, row.label = WANTED, None, json.dumps(label, ensure_ascii=False)
    db.commit()


def keep(links: list[str], match_id: str, label: dict) -> list[str]:
    """Liens des cartes demandées seulement : la page d'un BO3 en donne un par carte, nommé `<match>-<carte>-<n>.dem…`.
    Nom inattendu : l'ordre des liens, celui du menu « Démo 1, Démo 2… », qui suit les cartes. Sans `maps` (demande
    d'avant le 24/10), tous."""
    want = label.get("maps")
    if not want:
        return links
    named = re.compile(re.escape(match_id) + r"-(\d+)-\d+\.dem")
    out = []
    for i, u in enumerate(links, start=1):
        hit = named.search(u.split("?")[0])
        if (int(hit.group(1)) if hit else i) in want:
            out.append(u)
    return out


def take(db: Session, now: datetime, limit: int = PER_TOUR) -> list[dict]:
    """Matchs confiés à l'extension qui demande : en attente, en échec (moins de 3 essais) ou pris sans réponse depuis
    20 min. Marqués « picked » pour qu'un autre PC ne les prenne pas en même temps."""
    rows = list(db.scalars(select(DemoSource).where(DemoSource.source == SOURCE, or_(
        DemoSource.status == WANTED,
        and_(DemoSource.status == "error", DemoSource.attempts < MAX_ATTEMPTS),
        and_(DemoSource.status == PICKED, DemoSource.updated_at < now - PICK_AGAIN))).order_by(DemoSource.id).limit(limit)))
    for r in rows:
        r.status, r.updated_at = PICKED, now
    db.commit()
    return [{"match_id": r.external_id, "url": scout.room_url(r.external_id)} for r in rows]


def failed(db: Session, row: DemoSource, error: str) -> None:
    """Pas de lien obtenu (démo expirée, pas encore disponible) : nouvel essai plus tard, abandon au 3e échec."""
    row.attempts = (row.attempts or 0) + 1
    row.status = "abandoned" if row.attempts >= MAX_ATTEMPTS else "error"
    row.error = error[:500]
    db.commit()


def queue(db: Session) -> dict:
    """État de la file pour la page Intégrations : en attente d'un PC, en cours, importées."""
    rows = list(db.scalars(select(DemoSource.status).where(DemoSource.source == SOURCE)))
    return {"waiting": sum(s in (WANTED, PICKED, "error") for s in rows),
            "running": sum(s in ("downloading", "importing") for s in rows), "done": rows.count("done")}


def auto(db: Session, c: FaceitClient, found: dict, maps: dict[str, MapMeta], now: datetime, free: int) -> int:
    """Pour chaque match FACEIT des 14 prochains jours pas encore servi : 2 démos ESEA de l'adversaire en file, sur ses
    cartes probables d'abord. Une seule fois par match ; une erreur de FACEIT est retentée au passage suivant."""
    if free < LOW_DISK:
        return 0
    n = 0
    for ev in found.get("events") or []:
        row = db.scalar(select(CalendarEvent).where(CalendarEvent.source == "faceit",
                                                    CalendarEvent.external_id == ev["external_id"]))
        if row is None or row.demos_requested_at or not ev.get("opponent_id") or not now <= row.starts_at <= now + AHEAD:
            continue
        try:
            team = overview(c, ev["opponent_id"], maps)
        except FaceitError:
            continue
        prefer = [m["map"] for m in (map_odds.stored(row) or {}).get("maps", [])[:3]]
        picked = choose(db, team, AUTO, prefer)
        enqueue(db, team["team"], picked, "auto")
        row.demos_requested_at = now
        n += sum(len(m["pick"]) for m in picked)
    db.commit()
    return n


def resolve(db: Session, c: FaceitClient, name: str, now: datetime) -> tuple[dict | None, list[str]]:
    """({team_id, name}, cartes probables) de l'adversaire demandé : notre prochain match FACEIT si `name` est vide, sinon
    le match du calendrier contre lui, sinon une recherche d'équipe sur FACEIT."""
    events = list(db.scalars(select(CalendarEvent).where(CalendarEvent.starts_at >= now - timedelta(hours=3))
                             .order_by(CalendarEvent.starts_at)))
    want = _norm(name)
    ev = next((e for e in events if e.source == "faceit"), None) if not want else \
        next((e for e in events if _norm(e.opponent) and (want in _norm(e.opponent) or _norm(e.opponent) in want)), None)
    if ev is not None and ev.source == "faceit" and ev.external_id:
        teams = (c.get(f"/matches/{ev.external_id}", ttl=3600).get("teams") or {}).values()
        them = next((t for t in teams if _norm(t.get("name") or "") == _norm(ev.opponent)), None)
        if them and them.get("faction_id"):
            prefer = [m["map"] for m in (map_odds.stored(ev) or {}).get("maps", [])[:3]]
            return {"team_id": them["faction_id"], "name": them.get("name") or ev.opponent}, prefer
    if not want:
        return None, []
    items = c.get("/search/teams", {"nickname": name, "game": "cs2", "offset": 0, "limit": 10}).get("items", [])
    hit = next((t for t in items if _norm(t.get("name") or "") == want), items[0] if items else None)
    return ({"team_id": hit["team_id"], "name": hit.get("name") or name}, []) if hit else (None, [])
