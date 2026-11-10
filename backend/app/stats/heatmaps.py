# backend/app/stats/heatmaps.py
"""Heatmaps (sous-projet 5) : présence des joueurs, kills, morts et zones de contrôle CT/T.

Les positions viennent des images de replay déjà stockées (aucune ré-importation). Elles sont agrégées dans une grille
de BIN pixels radar par niveau de carte. Seules les cases non vides sont renvoyées, sous la forme [ix, iy, valeur…]."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta, level_for_z
from app.parsing.model import FLAG_ALIVE
from app.storage.frames_codec import decode_fields
from app.storage.models import Kill, Match, MatchPlayer, Round, RoundFrames

BIN = 8          # px radar par case (radar 1024 px → grille 128 × 128)
GRID = 1024 // BIN
KINDS = ("presence", "kills", "deaths", "control")
# Présence et contrôle comptent des images : chacune pèse sa durée, en images à 16 i/s (poids REF_FPS / sample_rate du
# match). Une bibliothèque qui mélange 16 et 32 i/s (ré-analyse en cours, démo dont le fichier manque et reste à 16)
# n'est donc pas faussée, et une démo à 16 i/s donne exactement les mêmes valeurs qu'avant.
REF_FPS = 16


def _cell(v: float) -> int | float:
    """Valeur d'une case : entière comme avant pour les images à 16 i/s, sinon arrondie au centième."""
    r = round(float(v), 2)
    return int(r) if r.is_integer() else r


@dataclass
class HeatFilters:
    map: str
    kind: str = "presence"
    side: str | None = None
    team: int | None = None
    player: str | None = None
    buy: list[str] | None = None
    t_from: float = 0.0          # secondes depuis la fin du freeze time
    t_to: float | None = None
    match: int | None = None
    weapon: list[str] | None = None  # kills / morts : seulement ceux faits avec ces armes


def _bins(meta: MapMeta, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    px = (x - meta.pos_x) / meta.scale
    py = (meta.pos_y - y) / meta.scale
    ok = (px >= 0) & (px < 1024) & (py >= 0) & (py < 1024)
    return (px / BIN).astype(np.int32), (py / BIN).astype(np.int32), ok


def _level_idx(meta: MapMeta, z: np.ndarray) -> np.ndarray:
    out = np.zeros(z.shape, np.int32)
    for k, lvl in enumerate(meta.levels):
        out[(z >= lvl.z_min) & (z < lvl.z_max)] = k
    return out


def heatmap(session: Session, meta: MapMeta, f: HeatFilters) -> dict:
    stmt = select(Match).where(Match.map_name == f.map)
    if f.match:
        stmt = stmt.where(Match.id == f.match)
    if f.team:
        stmt = stmt.where((Match.team_a_id == f.team) | (Match.team_b_id == f.team))
    nl = len(meta.levels)
    # grilles : [niveau, iy, ix, canal] ; canal 0 = CT, 1 = T (presence/control), 0 seul sinon
    grid = np.zeros((nl, GRID, GRID, 2), np.float64)
    points: list[dict] = []
    rounds_used = 0
    for m in session.scalars(stmt):
        team_of = {mp.steamid: mp.team_id for mp in session.scalars(select(MatchPlayer).where(MatchPlayer.match_id == m.id))}
        names = {mp.steamid: mp.name_in_match for mp in m.players}
        for r in session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)):
            side_of = {sid: ("CT" if tid == r.ct_team_id else "T") for sid, tid in team_of.items()}

            def keep(sid: str | None) -> bool:
                if sid is None or sid not in side_of:
                    return False
                s = side_of[sid]
                if f.side and s != f.side or f.team and team_of[sid] != f.team or f.player and sid != f.player:
                    return False
                return not f.buy or (r.ct_buy_type if s == "CT" else r.t_buy_type) in f.buy

            if not any(keep(sid) for sid in side_of):
                continue
            rounds_used += 1
            lo = r.freeze_end_tick + int(f.t_from * m.demo_tickrate)
            hi = r.freeze_end_tick + int(f.t_to * m.demo_tickrate) if f.t_to is not None else r.end_tick
            if f.kind in ("kills", "deaths"):
                for k in session.scalars(select(Kill).where(Kill.round_id == r.id, Kill.tick >= lo, Kill.tick <= hi)):
                    who = k.attacker if f.kind == "kills" else k.victim
                    if not keep(who) or k.attacker == k.victim or (f.weapon and k.weapon not in f.weapon):
                        continue
                    x, y, z = ((k.attacker_x, k.attacker_y, k.attacker_z) if f.kind == "kills"
                               else (k.victim_x, k.victim_y, k.victim_z))
                    if x is None:
                        continue
                    rx, ry = (x - meta.pos_x) / meta.scale, (meta.pos_y - y) / meta.scale
                    points.append({"x": round(rx, 1), "y": round(ry, 1), "level": level_for_z(meta, z),
                                   "side": side_of[who], "player": names.get(who, who), "weapon": k.weapon,
                                   "headshot": k.headshot, "match_id": m.id, "round_number": r.number, "tick": k.tick})
                    ix, iy = int(rx // BIN), int(ry // BIN)
                    if 0 <= ix < GRID and 0 <= iy < GRID:
                        li = [lv.name for lv in meta.levels].index(level_for_z(meta, z))
                        grid[li, iy, ix, 0 if side_of[who] == "CT" else 1] += 1
                continue
            fr = session.get(RoundFrames, r.id)
            if fr is None:
                continue
            fd = decode_fields(fr.blob)
            tsel = (fd.ticks >= lo) & (fd.ticks <= hi)
            if not tsel.any():
                continue
            cols = [j for j, sid in enumerate(fd.players) if keep(sid)]
            if not cols:
                continue
            x = fd.fields["x"][tsel][:, cols]
            y = fd.fields["y"][tsel][:, cols]
            z = fd.fields["z"][tsel][:, cols]
            alive = (fd.fields["flags"][tsel][:, cols] & FLAG_ALIVE) > 0
            sides = np.array([0 if side_of[fd.players[j]] == "CT" else 1 for j in cols])
            ch = np.broadcast_to(sides, x.shape)
            ix, iy, ok = _bins(meta, x, y)
            ok &= alive
            lv = _level_idx(meta, z)
            np.add.at(grid, (lv[ok], iy[ok], ix[ok], ch[ok]), REF_FPS / (m.sample_rate or REF_FPS))  # durée d'une image

    out_levels = {}
    for li, lvl in enumerate(meta.levels):
        g = grid[li]
        nz = np.argwhere(g.sum(axis=2) > 0)
        if f.kind == "control":
            cells = [[int(ix), int(iy), _cell(g[iy, ix, 0]), _cell(g[iy, ix, 1])] for iy, ix in nz]
        else:
            cells = [[int(ix), int(iy), _cell(g[iy, ix, 0] + g[iy, ix, 1])] for iy, ix in nz]
        out_levels[lvl.name] = cells
    return {"map": f.map, "kind": f.kind, "bin": BIN, "grid": GRID, "rounds": rounds_used,
            "levels": out_levels, "points": points[:5000]}


def players_on_map(session: Session, map_name: str) -> list[dict]:
    seen: dict[str, dict] = {}
    teams = defaultdict(str)
    for m in session.scalars(select(Match).where(Match.map_name == map_name)):
        teams[m.team_a_id], teams[m.team_b_id] = m.team_a.name, m.team_b.name
        for mp in m.players:
            seen[mp.steamid] = {"steamid": mp.steamid, "name": mp.name_in_match, "team_id": mp.team_id,
                                "team": teams[mp.team_id]}
    return sorted(seen.values(), key=lambda p: (p["team"].lower(), p["name"].lower()))
