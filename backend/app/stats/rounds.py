# backend/app/stats/rounds.py
"""Recherche de rounds sur toute la bibliothèque (sous-projet 3).

Point de vue : l'équipe `team` si fournie, sinon le camp `side`. Les filtres d'achat et de résultat s'appliquent au
point de vue (achat adverse via `opp_buy`). Sans point de vue, `buy` retient les rounds où l'un des camps a ce type
d'achat."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.storage.models import Annotation, BombEvent, Comment, Kill, Match, MatchPlayer, Team
from app.storage.repository import _match_summary, _rounds_with_scores


@dataclass
class RoundFilters:
    map: str | None = None
    team: int | None = None         # équipe de référence (point de vue)
    opponent: int | None = None
    side: str | None = None         # CT / T : camp du point de vue
    buy: list[str] | None = None    # types d'achat du point de vue
    opp_buy: list[str] | None = None
    result: str | None = None       # won / lost (point de vue requis)
    bomb: str | None = None         # planted / A / B / none
    half: str | None = None         # first / second / ot
    pistol: bool | None = None
    match: int | None = None
    match_ids: set[int] | None = None  # filtres de bibliothèque (dossier, événement, période…)
    quick: list[str] | None = None     # préfiltres : second, opening_won, opening_lost, clutch_won, eco_won, commented, annotated
    weapon: list[str] | None = None    # rounds avec au moins un kill à l'une de ces armes (par le point de vue s'il existe)
    round_ids: set[int] | None = None  # restriction à ces rounds (ex. une tactique détectée par le playbook)
    limit: int = 500


QUICK = ("second", "opening_won", "opening_lost", "clutch_won", "eco_won", "commented", "annotated")


def round_story(kills: list[Kill], side_of: dict[str, str]) -> tuple[str | None, dict[str, int]]:
    """(camp auteur du premier kill, {camp: nb d'adversaires lors de son clutch}) à partir des kills du round."""
    alive = {s: {sid for sid, x in side_of.items() if x == s} for s in ("CT", "T")}
    opening, clutch = None, {}
    for k in kills:
        a, v = side_of.get(k.attacker or ""), side_of.get(k.victim)
        if opening is None and a and v and a != v:
            opening = a
        if v:
            alive[v].discard(k.victim)
            for s in ("CT", "T"):
                other = alive["T" if s == "CT" else "CT"]
                if len(alive[s]) == 1 and other and s not in clutch:
                    clutch[s] = len(other)
    return opening, clutch


def _half(n: int) -> str:
    return "first" if n <= 12 else "second" if n <= 24 else "ot"


def search_rounds(session: Session, f: RoundFilters) -> dict:
    stmt = select(Match).order_by(Match.id.desc())
    if f.map:
        stmt = stmt.where(Match.map_name == f.map)
    if f.match:
        stmt = stmt.where(Match.id == f.match)
    for tid in (f.team, f.opponent):
        if tid:
            stmt = stmt.where(or_(Match.team_a_id == tid, Match.team_b_id == tid))
    matches = [m for m in session.scalars(stmt) if f.match_ids is None or m.id in f.match_ids]
    round_ids = [r.id for m in matches for r in m.rounds]
    plants: dict[int, str | None] = {}
    for b in session.scalars(select(BombEvent).where(BombEvent.round_id.in_(round_ids), BombEvent.type == "plant")):
        plants.setdefault(b.round_id, b.site)
    kills = dict(session.execute(select(Kill.round_id, func.count()).where(Kill.round_id.in_(round_ids))
                                 .group_by(Kill.round_id)).all())
    by_round: dict[int, list[Kill]] = defaultdict(list)
    if f.quick or f.weapon:
        for k in session.scalars(select(Kill).where(Kill.round_id.in_(round_ids)).order_by(Kill.tick)):
            by_round[k.round_id].append(k)
    demo_ids = {m.demo_id for m in matches}
    commented = annotated = set()
    if f.quick and "commented" in f.quick:
        commented = {tuple(x) for x in session.execute(select(Comment.demo_id, Comment.round_number)
                                        .where(Comment.demo_id.in_(demo_ids)))}
    if f.quick and "annotated" in f.quick:
        annotated = {tuple(x) for x in session.execute(select(Annotation.demo_id, Annotation.round_number)
                                        .where(Annotation.demo_id.in_(demo_ids)))}
    weapons = set(f.weapon or [])

    out, total = [], 0
    for m in matches:
        summary = _match_summary(m)
        team_of = {mp.steamid: mp.team_id for mp in session.scalars(select(MatchPlayer).where(MatchPlayer.match_id == m.id))}
        for r in _rounds_with_scores(m):
            # point de vue
            if f.team:
                pov = "CT" if r["ct_team_id"] == f.team else "T"
            else:
                pov = f.side
            if f.side and pov != f.side:
                continue
            if f.round_ids is not None and r["id"] not in f.round_ids:
                continue
            opp = None if pov is None else ("T" if pov == "CT" else "CT")
            buy_of = lambda s: r["ct_buy_type"] if s == "CT" else r["t_buy_type"]
            if f.buy:
                if pov is None:
                    if r["ct_buy_type"] not in f.buy and r["t_buy_type"] not in f.buy:
                        continue
                elif buy_of(pov) not in f.buy:
                    continue
            if f.opp_buy and opp and buy_of(opp) not in f.opp_buy:
                continue
            if f.result and pov:
                if (r["winner_side"] == pov) != (f.result == "won"):
                    continue
            site = plants.get(r["id"], False)
            if f.bomb == "planted" and site is False or f.bomb == "none" and site is not False:
                continue
            if f.bomb in ("A", "B") and site != f.bomb:
                continue
            if f.half and _half(r["number"]) != f.half:
                continue
            if f.pistol is not None and (r["number"] in (1, 13)) != f.pistol:
                continue
            opening, clutch = None, {}
            if f.quick or f.weapon:
                side_of = {sid: ("CT" if tid == r["ct_team_id"] else "T") for sid, tid in team_of.items()}
                rk = by_round.get(r["id"], [])
                opening, clutch = round_story(rk, side_of)
                if weapons and not any(k.weapon in weapons and (pov is None or side_of.get(k.attacker or "") == pov)
                                       and side_of.get(k.attacker or "") != side_of.get(k.victim) for k in rk):
                    continue
                if f.quick and not _quick_ok(f.quick, r, pov, opening, clutch, buy_of,
                                             (m.demo_id, r["number"]), commented, annotated):
                    continue
            total += 1
            if len(out) < f.limit:
                out.append({**r, "match": summary, "pov_side": pov, "bomb_site": None if site is False else site,
                            "bomb_planted": site is not False, "kills": kills.get(r["id"], 0),
                            "opening_side": opening, "clutch": clutch})
    return {"total": total, "rounds": out}


def _quick_ok(quick: list[str], r: dict, pov: str | None, opening: str | None, clutch: dict[str, int], buy_of,
              key: tuple[int, int], commented: set, annotated: set) -> bool:
    """Tous les préfiltres demandés doivent être vrais. Sans point de vue, « gagné » vaut pour l'un des camps."""
    sides = [pov] if pov else ["CT", "T"]
    for q in quick:
        if q == "second" and r["number"] not in (2, 14):
            return False
        if q == "opening_won" and pov and opening != pov:
            return False
        if q == "opening_lost" and pov and (opening is None or opening == pov):
            return False
        if q == "clutch_won" and not any(s in clutch and r["winner_side"] == s for s in sides):
            return False
        if q == "eco_won" and not any(buy_of(s) in ("eco", "semi") and r["winner_side"] == s for s in sides):
            return False
        if q == "commented" and key not in commented:
            return False
        if q == "annotated" and key not in annotated:
            return False
    return True


def teams_list(session: Session) -> list[dict]:
    counts = defaultdict(int)
    for a, b in session.execute(select(Match.team_a_id, Match.team_b_id)):
        counts[a] += 1
        counts[b] += 1
    return sorted(({"id": t.id, "name": t.name, "matches": counts[t.id]} for t in session.scalars(select(Team))
                   if counts[t.id]), key=lambda t: (-t["matches"], t["name"].lower()))
