# backend/app/stats/highlights.py
"""Moments forts détectés automatiquement : ace, 4K, 3K, clutchs 1vX gagnés, rafales, ninja defuse, collatéral,
wallbang, no-scope, kill à travers une fumée, kill aveuglé, couteau, Zeus."""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.storage.models import BombEvent, Kill, Match, MatchPlayer, Round

TYPES = {
    "ace": ("Ace", 100), "clutch": ("Clutch", 90), "4k": ("4 kills", 80), "ninja": ("Ninja defuse", 70),
    "burst": ("Rafale", 60), "collateral": ("Collatéral", 60), "3k": ("3 kills", 50), "noscope": ("No-scope", 45),
    "wallbang": ("Wallbang", 40), "smoke": ("À travers la fumée", 35), "blind": ("Aveuglé", 35),
    "knife": ("Couteau", 40), "zeus": ("Zeus", 35),
}
BURST_S = 3.0  # 3 kills ou plus en moins de 3 s
SNIPERS = ("awp", "ssg08", "scar20", "g3sg1")


def match_highlights(session: Session, m: Match) -> list[dict]:
    tr = m.demo_tickrate or 64
    mps = list(session.scalars(select(MatchPlayer).where(MatchPlayer.match_id == m.id)))
    name = {p.steamid: p.name_in_match for p in mps}
    team = {p.steamid: p.team_id for p in mps}
    teams = {m.team_a_id: m.team_a.name, m.team_b_id: m.team_b.name}
    rounds = list(session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)))
    rids = [r.id for r in rounds]
    kills, bombs = defaultdict(list), defaultdict(list)
    for k in session.scalars(select(Kill).where(Kill.round_id.in_(rids)).order_by(Kill.tick)):
        kills[k.round_id].append(k)
    for b in session.scalars(select(BombEvent).where(BombEvent.round_id.in_(rids)).order_by(BombEvent.tick)):
        bombs[b.round_id].append(b)
    out = []

    def add(kind: str, r: Round, player: str | None, tick: int, detail: str = "", extra: int = 0):
        label, score = TYPES[kind]
        out.append({"type": kind, "label": label, "score": score + extra, "detail": detail, "match_id": m.id,
                    "map": m.map_name, "round": r.number, "round_id": r.id, "tick": tick, "player": player,
                    "player_name": name.get(player or "", player or ""), "team": teams.get(team.get(player or "")),
                    "played_at": m.played_at.isoformat() if m.played_at else None})

    for r in rounds:
        side_of = {sid: ("CT" if t == r.ct_team_id else "T") for sid, t in team.items()}
        rk = [k for k in kills[r.id] if k.attacker and k.attacker != k.victim
              and (k.attacker_side or side_of.get(k.attacker)) != (k.victim_side or side_of.get(k.victim))]
        by_player: dict[str, list] = defaultdict(list)
        for k in rk:
            by_player[k.attacker].append(k)
        for sid, ks in by_player.items():
            n = len(ks)
            secs = (ks[-1].tick - ks[0].tick) / tr
            span = f"en {round(secs)} s" if secs <= 10 else ""  # la durée n'a d'intérêt que si les kills s'enchaînent
            if n >= 5:
                add("ace", r, sid, ks[0].tick, span)
            elif n == 4:
                add("4k", r, sid, ks[0].tick, span)
            elif n == 3:
                add("3k", r, sid, ks[0].tick, span)
            # rafale : 3 kills en moins de BURST_S
            for i in range(len(ks) - 2):
                if ks[i + 2].tick - ks[i].tick <= BURST_S * tr:
                    add("burst", r, sid, ks[i].tick, f"{sum(1 for k in ks if ks[i].tick <= k.tick <= ks[i].tick + BURST_S * tr)} kills en "
                        f"{(ks[i + 2].tick - ks[i].tick) / tr:.1f} s")
                    break
            ticks = defaultdict(int)
            for k in ks:
                ticks[k.tick] += 1
            for t, c in ticks.items():
                if c >= 2:
                    add("collateral", r, sid, t, f"{c} kills d'une balle")
        for k in rk:
            w = k.weapon or ""
            if k.penetrated > 0:
                add("wallbang", r, k.attacker, k.tick, w)
            if k.noscope and w in SNIPERS:
                add("noscope", r, k.attacker, k.tick, w)
            if k.through_smoke:
                add("smoke", r, k.attacker, k.tick, w)
            if k.attacker_blind:
                add("blind", r, k.attacker, k.tick, w)
            if w.startswith("knife") or w.startswith("bayonet"):
                add("knife", r, k.attacker, k.tick)
            if w == "taser":
                add("zeus", r, k.attacker, k.tick)
        # clutch : dernier en vie de son camp face à 2 adversaires ou plus, et round gagné
        alive = {s: {sid for sid, x in side_of.items() if x == s} for s in ("CT", "T")}
        clutch: dict[str, tuple[str, int, int]] = {}
        for k in kills[r.id]:
            vs = k.victim_side or side_of.get(k.victim)
            if vs in alive:
                alive[vs].discard(k.victim)
            for s, o in (("CT", "T"), ("T", "CT")):
                if len(alive[s]) == 1 and len(alive[o]) >= 2 and s not in clutch:
                    clutch[s] = (next(iter(alive[s])), len(alive[o]), k.tick)
        if r.winner_side in clutch:
            sid, x, t = clutch[r.winner_side]
            add("clutch", r, sid, t, f"1v{x}", extra=2 * x)
        # ninja defuse : désamorçage avec au moins un T encore en vie
        for b in bombs[r.id]:
            if b.type == "defuse":
                t_alive = {sid for sid, s in side_of.items() if s == "T"} - {k.victim for k in kills[r.id] if k.tick <= b.tick}
                if t_alive:
                    add("ninja", r, b.player, b.tick - 10 * tr, f"{len(t_alive)} T en vie")
    return out


def search_highlights(session: Session, types: list[str] | None = None, map_name: str | None = None,
                      player: str | None = None, match_id: int | None = None, cache=None) -> list[dict]:
    q = select(Match)
    if map_name:
        q = q.where(Match.map_name == map_name)
    if match_id:
        q = q.where(Match.id == match_id)
    out = []
    for m in session.scalars(q):
        out += cache(m) if cache else match_highlights(session, m)
    if types:
        out = [h for h in out if h["type"] in types]
    if player:
        out = [h for h in out if h["player"] == player]
    out.sort(key=lambda h: (-h["score"], -(h["match_id"]), h["round"]))
    return out
