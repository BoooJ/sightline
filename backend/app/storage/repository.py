# backend/app/storage/repository.py
from __future__ import annotations

import json
from collections import defaultdict
from datetime import date, datetime

from sqlalchemy import delete, insert, or_, select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta, resolve_site
from app.parsing.model import ParsedDemo
from app.storage.frames_codec import CODEC_VERSION, encode_frames, frames_wire, pack, unpack
from app.storage.labels import LibraryFilters, labels_of, match_date, match_kind
from app.storage.models import (BombEvent, Blind, Damage, Demo, Grenade, Kill, Match, MatchPlayer, Player,
                                Purchase, Round, RoundFrames, ShareLink, Shot, Team)


# ------------------------------------------------------------------ écriture

def _team(session: Session, name: str) -> Team:
    t = session.scalar(select(Team).where(Team.name == name))
    if t is None:
        t = Team(name=name)
        session.add(t)
        session.flush()
    return t


def _xyz(p):
    return (p[0], p[1], p[2]) if p is not None else (None, None, None)


def _remap_share_layers(session: Session, match_id: int, old_numbers: dict[int, int], new_ids: dict[int, int]) -> None:
    """Rounds superposés des liens de partage (seule donnée d'équipe qui vise des ids de rounds) : une ré-analyse
    recrée les rounds sous d'autres ids, chaque calque suit le round de même numéro (retiré si ce numéro n'existe plus)."""
    for link in session.scalars(select(ShareLink).where(ShareLink.match_id == match_id)):
        layers = json.loads(link.layers or "[]")
        moved = [new_ids[old_numbers[x]] for x in layers if x in old_numbers and old_numbers[x] in new_ids]
        if moved != layers:
            link.layers = json.dumps(moved)


def save_parsed_demo(session: Session, demo_id: int, parsed: ParsedDemo, maps: dict[str, MapMeta]) -> int:
    old = session.scalar(select(Match).where(Match.demo_id == demo_id))
    old_numbers: dict[int, int] = {}  # ancien id de round → numéro (rounds superposés des liens de partage)
    if old is not None:
        # Ré-analyse : la ligne du match est gardée et mise à jour sur place (même id : liens, stratbook). La supprimer
        # déclencherait les ON DELETE des tables qui la visent : liens de partage et débriefs effacés (CASCADE) ;
        # notes, vetos, objectifs et comms détachés (SET NULL). Seules les données tirées de la démo sont refaites :
        # joueurs du match et rounds (frames, kills, dégâts… suivent par ON DELETE CASCADE sur rounds.id).
        old_numbers = dict(session.execute(select(Round.id, Round.number).where(Round.match_id == old.id)).all())
        session.execute(delete(Round).where(Round.match_id == old.id))
        session.execute(delete(MatchPlayer).where(MatchPlayer.match_id == old.id))
        session.expire(old, ["rounds", "players"])

    teams = {t.key: _team(session, t.name) for t in parsed.teams}
    for p in parsed.players:
        pl = session.get(Player, p.steamid)
        if pl is None:
            session.add(Player(steamid=p.steamid, last_name=p.name))
        else:
            pl.last_name = p.name
    first, last = parsed.rounds[0], parsed.rounds[-1]
    fields = dict(
        map_name=parsed.map_name, server_name=parsed.server_name,
        demo_tickrate=parsed.tickrate, sample_rate=parsed.sample_rate,
        team_a_id=teams["A"].id, team_b_id=teams["B"].id,
        score_a=parsed.score.get("A", 0), score_b=parsed.score.get("B", 0), rounds_count=len(parsed.rounds),
        duration_s=(last.end_tick - first.start_tick) / parsed.tickrate,
    )
    if old is None:
        match = Match(demo_id=demo_id, **fields)
        session.add(match)
    else:
        match = old
        for k, v in fields.items():
            setattr(match, k, v)
    session.flush()
    for p in parsed.players:
        session.add(MatchPlayer(match_id=match.id, steamid=p.steamid, name_in_match=p.name,
                                team_id=teams[p.team_key].id, starting_side=p.starting_side))

    rid: dict[int, int] = {}
    for r in parsed.rounds:
        row = Round(match_id=match.id, number=r.number, start_tick=r.start_tick, freeze_end_tick=r.freeze_end_tick,
                    end_tick=r.end_tick, winner_side=r.winner_side, end_reason=r.end_reason,
                    ct_team_id=teams[r.ct_team_key].id, t_team_id=teams[r.t_team_key].id,
                    score_ct_before=r.score_ct_before, score_t_before=r.score_t_before,
                    ct_equip_value=r.ct_equip_value, t_equip_value=r.t_equip_value,
                    ct_buy_type=r.ct_buy_type, t_buy_type=r.t_buy_type)
        session.add(row)
        session.flush()
        rid[r.number] = row.id
    if old_numbers:
        _remap_share_layers(session, match.id, old_numbers, rid)

    for rn, fr in parsed.frames.items():
        session.add(RoundFrames(round_id=rid[rn], codec_version=CODEC_VERSION, tick_count=len(fr.ticks),
                                blob=encode_frames(fr)))

    def bulk(model, rows):
        if rows:
            session.execute(insert(model), rows)

    bulk(Kill, [dict(round_id=rid[k.round_number], tick=k.tick, attacker=k.attacker, victim=k.victim,
                     assister=k.assister, attacker_side=k.attacker_side, victim_side=k.victim_side,
                     flash_assist=k.flash_assist, weapon=k.weapon, headshot=k.headshot, penetrated=k.penetrated,
                     through_smoke=k.through_smoke, noscope=k.noscope, attacker_blind=k.attacker_blind,
                     attacker_x=_xyz(k.attacker_pos)[0], attacker_y=_xyz(k.attacker_pos)[1],
                     attacker_z=_xyz(k.attacker_pos)[2], victim_x=k.victim_pos[0], victim_y=k.victim_pos[1],
                     victim_z=k.victim_pos[2], is_opening=k.is_opening, is_trade=k.is_trade,
                     traded_player=k.traded_player, attacker_place=k.attacker_place,
                     victim_place=k.victim_place) for k in parsed.kills])
    bulk(Damage, [dict(round_id=rid[d.round_number], tick=d.tick, attacker=d.attacker, victim=d.victim,
                       attacker_side=d.attacker_side, victim_side=d.victim_side, weapon=d.weapon,
                       dmg_health=d.dmg_health, dmg_health_real=d.dmg_health_real, dmg_armor=d.dmg_armor,
                       hitgroup=d.hitgroup) for d in parsed.damages])
    bulk(Shot, [dict(round_id=rid[s.round_number], tick=s.tick, shooter=s.shooter, weapon=s.weapon,
                     x=s.pos[0], y=s.pos[1], z=s.pos[2], yaw=s.yaw, pitch=s.pitch, speed=s.speed) for s in parsed.shots])
    bulk(Grenade, [dict(round_id=rid[g.round_number], type=g.type, thrower=g.thrower, throw_tick=g.throw_tick,
                        throw_x=g.throw_pos[0], throw_y=g.throw_pos[1], throw_z=g.throw_pos[2],
                        throw_yaw=g.throw_yaw, throw_pitch=g.throw_pitch,
                        trajectory=pack([list(p) for p in g.trajectory]),
                        detonate_tick=g.detonate_tick, detonate_x=_xyz(g.detonate_pos)[0],
                        detonate_y=_xyz(g.detonate_pos)[1], detonate_z=_xyz(g.detonate_pos)[2],
                        end_tick=g.end_tick) for g in parsed.grenades])
    meta = maps.get(parsed.map_name)
    bulk(BombEvent, [dict(round_id=rid[b.round_number], tick=b.tick, type=b.type, player=b.player,
                          site=(resolve_site(meta, b.pos[0], b.pos[1]) if meta and b.pos and b.type == "plant"
                                else None),
                          x=_xyz(b.pos)[0], y=_xyz(b.pos)[1], z=_xyz(b.pos)[2]) for b in parsed.bomb_events])
    bulk(Purchase, [dict(round_id=rid[p.round_number], tick=p.tick, player=p.player, item=p.item, cost=p.cost)
                    for p in parsed.purchases])
    bulk(Blind, [dict(round_id=rid[b.round_number], tick=b.tick, attacker=b.attacker, victim=b.victim,
                      duration=b.duration) for b in parsed.blinds])
    session.get(Demo, demo_id).imported_at = datetime.now()
    session.flush()
    return match.id


# ------------------------------------------------------------------ lecture

def demo_to_dict(d: Demo) -> dict:
    return {"id": d.id, "file_name": d.file_name, "path": d.path, "size": d.size, "status": d.status,
            "progress": d.progress, "step": d.step, "error_message": d.error_message,
            "parser_version": d.parser_version, "match_id": d.match.id if d.match else None,
            "created_at": d.created_at.isoformat() if d.created_at else None}


def _match_summary(m: Match, maps_display: dict[str, str] | None = None) -> dict:
    return {"id": m.id, "demo_id": m.demo_id, "map_name": m.map_name,
            "map_display_name": (maps_display or {}).get(m.map_name, _DISPLAY.get(m.map_name, m.map_name)),
            "played_at": m.played_at.isoformat() if m.played_at else None,
            "imported_at": m.demo.imported_at.isoformat() if m.demo and m.demo.imported_at else None,
            "duration_s": m.duration_s, "team_a": {"id": m.team_a.id, "name": m.team_a.name},
            "team_b": {"id": m.team_b.id, "name": m.team_b.name}, "score_a": m.score_a, "score_b": m.score_b,
            "rounds_count": m.rounds_count, "labels": labels_of(m), "kind": match_kind(m),
            "date": (match_date(m).isoformat() if match_date(m) else None)}


_DISPLAY = {"de_ancient": "Ancient", "de_anubis": "Anubis", "de_dust2": "Dust II", "de_inferno": "Inferno",
            "de_mirage": "Mirage", "de_nuke": "Nuke", "de_overpass": "Overpass", "de_train": "Train",
            "de_vertigo": "Vertigo", "de_cache": "Cache"}


def list_matches(session: Session, map_name: str | None = None, q: str | None = None,
                 lib: LibraryFilters | None = None) -> list[dict]:
    stmt = select(Match).order_by(Match.id.desc())
    if map_name:
        stmt = stmt.where(Match.map_name == map_name)
    if q:
        like = f"%{q.lower()}%"
        team_ids = select(Team.id).where(Team.name.ilike(like))
        player_matches = select(MatchPlayer.match_id).where(MatchPlayer.name_in_match.ilike(like))
        stmt = stmt.where(or_(Match.team_a_id.in_(team_ids), Match.team_b_id.in_(team_ids),
                              Match.id.in_(player_matches)))
    rows = [m for m in session.scalars(stmt) if lib is None or lib.keep(m)]
    if lib and lib.last_n:  # les N plus récents, après les autres filtres
        rows.sort(key=lambda m: (match_date(m) or date.min, m.id), reverse=True)
        rows = rows[: lib.last_n]
    return [_match_summary(m) for m in rows]


def _round_dict(r: Round, m: Match, score_after: tuple[int, int], tickrate: int) -> dict:
    winner_team = r.ct_team_id if r.winner_side == "CT" else r.t_team_id if r.winner_side == "T" else None
    return {"id": r.id, "number": r.number, "winner_side": r.winner_side, "winner_team_id": winner_team,
            "end_reason": r.end_reason, "ct_team_id": r.ct_team_id, "t_team_id": r.t_team_id,
            "score_a_after": score_after[0], "score_b_after": score_after[1],
            "ct_buy_type": r.ct_buy_type, "t_buy_type": r.t_buy_type,
            "ct_equip_value": r.ct_equip_value, "t_equip_value": r.t_equip_value,
            "start_tick": r.start_tick, "freeze_end_tick": r.freeze_end_tick, "end_tick": r.end_tick,
            "duration_s": (r.end_tick - r.freeze_end_tick) / tickrate}


def _rounds_with_scores(m: Match) -> list[dict]:
    a = b = 0
    out = []
    for r in m.rounds:
        if r.winner_side:
            winner_team = r.ct_team_id if r.winner_side == "CT" else r.t_team_id
            a += winner_team == m.team_a_id
            b += winner_team == m.team_b_id
        out.append(_round_dict(r, m, (a, b), m.demo_tickrate))
    return out


def _halves(rounds: list[dict], m: Match) -> list[dict]:
    def bucket(n: int) -> tuple[int, str]:
        if n <= 12:
            return 0, "1re mi-temps"
        if n <= 24:
            return 1, "2e mi-temps"
        ot = (n - 25) // 6 + 1
        return 1 + ot, f"Prolongation {ot}"
    halves: dict[int, dict] = {}
    for r in rounds:
        idx, label = bucket(r["number"])
        h = halves.setdefault(idx, {"label": label, "a": 0, "b": 0})
        h["a"] += r["winner_team_id"] == m.team_a_id
        h["b"] += r["winner_team_id"] == m.team_b_id
    return [halves[k] for k in sorted(halves)]


def get_match_detail(session: Session, match_id: int) -> dict | None:
    m = session.get(Match, match_id)
    if m is None:
        return None
    rounds = _rounds_with_scores(m)
    round_ids = [r.id for r in m.rounds]
    k_stats: dict[str, dict] = defaultdict(lambda: {"kills": 0, "deaths": 0, "assists": 0, "hs": 0, "dmg": 0})
    # frise : survivants de chaque équipe en fin de round et issue de la bombe
    team_of = {mp.steamid: mp.team_id for mp in m.players}
    roster = {t: sum(1 for x in team_of.values() if x == t) for t in (m.team_a_id, m.team_b_id)}
    dead: dict[int, dict[int, set]] = defaultdict(lambda: defaultdict(set))
    bomb: dict[int, str] = {}
    for b in session.scalars(select(BombEvent).where(BombEvent.round_id.in_(round_ids), BombEvent.type.in_(("plant", "explode", "defuse")))):
        if b.type != "plant" or b.round_id not in bomb:
            bomb[b.round_id] = {"plant": "planted", "explode": "exploded", "defuse": "defused"}[b.type]
    for k in session.scalars(select(Kill).where(Kill.round_id.in_(round_ids))):
        if k.victim in team_of:
            dead[k.round_id][team_of[k.victim]].add(k.victim)
        k_stats[k.victim]["deaths"] += 1
        if k.attacker and k.attacker != k.victim and k.attacker_side != k.victim_side:
            k_stats[k.attacker]["kills"] += 1
            k_stats[k.attacker]["hs"] += int(k.headshot)
        if k.assister:
            k_stats[k.assister]["assists"] += 1
    for d in session.scalars(select(Damage).where(Damage.round_id.in_(round_ids))):
        if d.attacker and d.attacker_side and d.attacker_side != d.victim_side:
            k_stats[d.attacker]["dmg"] += d.dmg_health_real
    n = max(1, len(round_ids))
    players = []
    for mp in m.players:
        s = k_stats[mp.steamid]
        players.append({"steamid": mp.steamid, "name": mp.name_in_match, "team_id": mp.team_id,
                        "starting_side": mp.starting_side, "kills": s["kills"], "deaths": s["deaths"],
                        "assists": s["assists"], "adr": round(s["dmg"] / n, 1),
                        "hs_pct": round(100 * s["hs"] / s["kills"], 1) if s["kills"] else 0.0})
    players.sort(key=lambda p: (p["team_id"], -p["kills"]))
    for rd in rounds:
        rd["survivors_a"] = max(0, roster[m.team_a_id] - len(dead[rd["id"]][m.team_a_id]))
        rd["survivors_b"] = max(0, roster[m.team_b_id] - len(dead[rd["id"]][m.team_b_id]))
        rd["bomb"] = bomb.get(rd["id"])
    return {**_match_summary(m), "server_name": m.server_name, "tickrate": m.demo_tickrate,
            "sample_rate": m.sample_rate, "halves": _halves(rounds, m), "rounds": rounds, "players": players}


def get_round_replay(session: Session, round_id: int) -> dict | None:
    r = session.get(Round, round_id)
    if r is None:
        return None
    m = r.match
    rd = next(x for x in _rounds_with_scores(m) if x["id"] == r.id)
    fr = session.get(RoundFrames, r.id)
    teams = {t.id: t.name for t in (m.team_a, m.team_b)}
    by_round = lambda model: session.scalars(select(model).where(model.round_id == r.id).order_by(model.tick))
    pos = lambda x, y, z: [x, y, z] if x is not None else None
    # positions entières (1 unité de jeu ≪ 1 pixel radar) : msgpack les code en 3 octets au lieu de 9
    ipos = lambda x, y, z: [round(x), round(y), round(z)]
    return {
        "match_id": m.id, "round": rd, "map_name": m.map_name, "tickrate": m.demo_tickrate,
        "teams": {"ct": {"id": r.ct_team_id, "name": teams[r.ct_team_id]},
                  "t": {"id": r.t_team_id, "name": teams[r.t_team_id]}},
        "players": [{"steamid": mp.steamid, "name": mp.name_in_match, "team_id": mp.team_id,
                     "side": "CT" if mp.team_id == r.ct_team_id else "T"} for mp in m.players],
        "frames": frames_wire(fr.blob) if fr else None,
        "kills": [{"tick": k.tick, "attacker": k.attacker, "victim": k.victim, "assister": k.assister,
                   "weapon": k.weapon, "headshot": k.headshot, "penetrated": k.penetrated,
                   "through_smoke": k.through_smoke, "noscope": k.noscope, "attacker_blind": k.attacker_blind,
                   "flash_assist": k.flash_assist, "attacker_pos": pos(k.attacker_x, k.attacker_y, k.attacker_z),
                   "victim_pos": [k.victim_x, k.victim_y, k.victim_z], "is_opening": k.is_opening,
                   "is_trade": k.is_trade, "attacker_place": k.attacker_place, "victim_place": k.victim_place}
                  for k in by_round(Kill)],
        "shots": [{"tick": s.tick, "shooter": s.shooter, "weapon": s.weapon, "pos": ipos(s.x, s.y, s.z),
                   "yaw": round(s.yaw, 1), "pitch": round(s.pitch, 1)} for s in by_round(Shot)],
        # dmg : dégâts réels (bornés à la vie restante : ADR, stats) ; raw, armor, weapon : dégâts bruts, armure et arme
        # de player_hurt (vue du joueur : coup de couteau dans le dos)
        "damages": [{"tick": d.tick, "attacker": d.attacker, "victim": d.victim, "dmg": d.dmg_health_real,
                     "raw": d.dmg_health, "armor": d.dmg_armor, "weapon": d.weapon,
                     "hitgroup": d.hitgroup} for d in by_round(Damage)],
        "grenades": [{"id": g.id, "type": g.type, "thrower": g.thrower, "throw_tick": g.throw_tick,
                      "throw_pos": [g.throw_x, g.throw_y, g.throw_z], "detonate_tick": g.detonate_tick,
                      "detonate_pos": pos(g.detonate_x, g.detonate_y, g.detonate_z), "end_tick": g.end_tick,
                      "trajectory": [[t, *ipos(x, y, z)] for t, x, y, z in unpack(g.trajectory)]}
                     for g in session.scalars(select(Grenade).where(Grenade.round_id == r.id)
                                              .order_by(Grenade.throw_tick))],
        "bomb": [{"tick": b.tick, "type": b.type, "player": b.player, "site": b.site, "pos": pos(b.x, b.y, b.z)}
                 for b in by_round(BombEvent)],
        "blinds": [{"tick": b.tick, "attacker": b.attacker, "victim": b.victim, "duration": b.duration}
                   for b in by_round(Blind)],
    }


def delete_demo(session: Session, demo_id: int) -> bool:
    d = session.get(Demo, demo_id)
    if d is None:
        return False
    session.execute(delete(Match).where(Match.demo_id == demo_id))
    session.delete(d)
    return True
