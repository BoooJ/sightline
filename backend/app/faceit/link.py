# backend/app/faceit/link.py
"""Rattachement des démos aux équipes FACEIT suivies.

Dans une démo, le nom d'équipe vient du serveur (souvent « team_pseudo » sur FACEIT) : une même équipe se retrouve
éclatée sous plusieurs noms. Le côté où jouent au moins MIN_KNOWN joueurs connus d'une équipe suivie est donc rattaché
à l'équipe locale portant le nom FACEIT, et toute l'analyse existante (scouting, playbook, timings…) la regroupe."""
from __future__ import annotations

import json
import logging
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.faceit.scout import MATCH_ID
from app.storage.models import Demo, FaceitDemo, FaceitTeam, Match, MatchPlayer, Round, Team
from app.storage.repository import _team

MIN_KNOWN = 3


def _retarget(db: Session, m: Match, old: int, new: int) -> None:
    if m.team_a_id == old:
        m.team_a_id = new
    if m.team_b_id == old:
        m.team_b_id = new
    db.execute(update(MatchPlayer).where(MatchPlayer.match_id == m.id, MatchPlayer.team_id == old).values(team_id=new))
    db.execute(update(Round).where(Round.match_id == m.id, Round.ct_team_id == old).values(ct_team_id=new))
    db.execute(update(Round).where(Round.match_id == m.id, Round.t_team_id == old).values(t_team_id=new))


def link_match(db: Session, match_id: int, teams: list[FaceitTeam] | None = None) -> bool:
    """Rattache les côtés du match aux équipes suivies, et la démo à son match FACEIT (nom de fichier). Renvoie True si
    quelque chose a changé."""
    m = db.get(Match, match_id)
    if m is None:
        return False
    changed = False
    demo = db.get(Demo, m.demo_id)
    found = MATCH_ID.search(Path(demo.path).name) if demo else None
    if found and db.get(FaceitDemo, demo.id) is None:
        db.add(FaceitDemo(demo_id=demo.id, match_id=found.group(0).lower()))
        changed = True
    teams = teams if teams is not None else list(db.scalars(select(FaceitTeam)))
    if not teams:
        return changed
    sides: dict[int, set[str]] = {m.team_a_id: set(), m.team_b_id: set()}
    for mp in db.scalars(select(MatchPlayer).where(MatchPlayer.match_id == m.id)):
        sides.setdefault(mp.team_id, set()).add(mp.steamid)
    for ft in teams:
        known = set(json.loads(ft.steamids or "[]"))
        for tid, sids in list(sides.items()):
            if len(sids & known) < MIN_KNOWN:
                continue
            target = _team(db, ft.name)
            other = m.team_b_id if tid == m.team_a_id else m.team_a_id
            if target.id not in (tid, other):
                _retarget(db, m, tid, target.id)
                sides[target.id] = sides.pop(tid)
                changed = True
    return changed


def link_all(db: Session) -> int:
    teams = list(db.scalars(select(FaceitTeam)))
    n = sum(link_match(db, mid, teams) for mid in db.scalars(select(Match.id)))
    db.commit()
    return n


def local_team_id(db: Session, name: str) -> int | None:
    """Équipe locale (scouting par démos) d'une équipe FACEIT, si au moins un match la concerne."""
    t = db.scalar(select(Team).where(Team.name == name))
    if t is None:
        return None
    has = db.scalar(select(Match.id).where((Match.team_a_id == t.id) | (Match.team_b_id == t.id)).limit(1))
    return t.id if has else None


def match_demos(db: Session, match_ids: list[str]) -> dict[str, list[dict]]:
    """Démos importées par match FACEIT : id de démo, statut, id du match Sightline."""
    out: dict[str, list[dict]] = {}
    if not match_ids:
        return out
    q = (select(FaceitDemo.match_id, Demo.id, Demo.status, Match.id, Match.map_name)
         .join(Demo, Demo.id == FaceitDemo.demo_id).outerjoin(Match, Match.demo_id == Demo.id)
         .where(FaceitDemo.match_id.in_(match_ids)))
    for fmid, did, status, mid, map_name in db.execute(q):
        out.setdefault(fmid, []).append({"demo_id": did, "status": status, "match_id": mid, "map": map_name})
    return out


def faceit_match_of(name: str) -> str | None:
    found = MATCH_ID.search(name)
    return found.group(0).lower() if found else None



def import_hook(db: Session, match_id: int) -> None:
    """Après chaque import : rattachement, sans jamais faire échouer l'import (point de sauvegarde)."""
    try:
        with db.begin_nested():
            link_match(db, match_id)
    except Exception:
        logging.getLogger(__name__).exception("Rattachement FACEIT du match %s impossible", match_id)
