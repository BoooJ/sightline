"""RawDemo (DataFrames bruts de demoparser2) -> ParsedDemo (modèle normalisé).

Règles de normalisation (validées sur démos eBot/ESL/FACEIT) :
- Début de match = dernier `round_start` portant le plus petit numéro de round (élimine
  les faux rounds d'avant-match et les restarts « live on 3 » de FACEIT).
- Seuls les `round_end` avec un vainqueur, après le début de match, sont gardés ; en cas de
  numéro de round répété (backup restauré) on garde la dernière occurrence ; renumérotation 1..N.
- Les équipes sont identifiées par appartenance des joueurs (pas par le nom de clan, qui peut
  être vide) : équipe "A" = CT au premier round.
"""
from __future__ import annotations

import logging
import math
from collections import Counter
from dataclasses import dataclass

import numpy as np
import pandas as pd

from app.parsing.extract import (
    FOV_PROP, MOVETYPE_LADDER, MOVETYPE_PROP, PARSER_VERSION, VIEWMODEL_PROPS, RawDemo, frame_step, mid_tick_offset,
)
from app.parsing.model import (
    FLAG_AIRBORNE, FLAG_ALIVE, FLAG_BOMB, FLAG_DEFUSER, FLAG_DEFUSING, FLAG_HELMET, FLAG_LADDER, FLAG_SCOPED,
    KEY_BACK, KEY_DUCK, KEY_FIRE, KEY_FORWARD, KEY_INSPECT, KEY_JUMP, KEY_LEFT, KEY_RELOAD, KEY_RIGHT, KEY_RIGHTCLICK,
    KEY_USE, KEY_WALK, NO_AMMO,
    PBlind, PBombEvent, PDamage, PGrenade, PKill, PPlayer, PPurchase, PRound, PRoundFrames,
    PShot, PTeam, ParsedDemo,
)

log = logging.getLogger(__name__)


@dataclass
class BuildOptions:
    trade_window_s: float = 5.0
    eco_max: int = 5000  # valeur d'équipement d'équipe < eco_max -> eco
    semi_max: int = 10000  # < semi_max -> semi
    force_max: int = 20000  # < force_max -> force, sinon full
    post_round_s: float = 5.0  # ticks gardés après la fin du round pour le replay
    buy_time_s: float = 20.0


SIDE_BY_TEAMNUM = {2: "T", 3: "CT"}
GRENADE_TYPES = {
    "CSmokeGrenadeProjectile": "smoke",
    "CFlashbangProjectile": "flash",
    "CHEGrenadeProjectile": "he",
    "CMolotovProjectile": "molotov",
    "CDecoyProjectile": "decoy",
}
NON_SHOT_WEAPONS = ("knife", "bayonet", "grenade", "flashbang", "molotov", "incgrenade", "decoy", "c4", "taser")
# colonne demoparser2 -> bit du champ "keys" des images (PARSER_VERSION 3)
KEY_COLUMNS = (("FORWARD", KEY_FORWARD), ("BACK", KEY_BACK), ("LEFT", KEY_LEFT), ("RIGHT", KEY_RIGHT), ("JUMP", KEY_JUMP),
               ("is_walking", KEY_WALK), ("FIRE", KEY_FIRE), ("RIGHTCLICK", KEY_RIGHTCLICK), ("RELOAD", KEY_RELOAD),
               ("USE", KEY_USE), ("INSPECT", KEY_INSPECT), ("ducking", KEY_DUCK))


# --------------------------------------------------------------------------- utilitaires

def _sid(v) -> str | None:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    s = str(v)
    if s in ("", "0", "nan", "None"):
        return None
    return s.split(".")[0]


def _f(v) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def _pos(row, prefix: str) -> tuple[float, float, float] | None:
    x, y, z = _f(row.get(f"{prefix}X")), _f(row.get(f"{prefix}Y")), _f(row.get(f"{prefix}Z"))
    return None if x is None or y is None or z is None else (x, y, z)


def _ev(raw: RawDemo, name: str) -> pd.DataFrame:
    df = raw.events.get(name)
    return df if df is not None and not df.empty else pd.DataFrame(columns=["tick"])


def buy_type(round_number: int, equip_value: int, opts: BuildOptions) -> str:
    if round_number in (1, 13):
        return "pistol"
    if equip_value < opts.eco_max:
        return "eco"
    if equip_value < opts.semi_max:
        return "semi"
    if equip_value < opts.force_max:
        return "force"
    return "full"


# --------------------------------------------------------------------------- rounds

@dataclass
class _RoundSpan:
    number: int
    start: int
    freeze_end: int
    end: int
    next_start: int  # borne exclusive pour l'attribution des événements
    winner: str | None
    reason: str | None


def compute_round_spans(raw: RawDemo) -> list[_RoundSpan]:
    starts = _ev(raw, "round_start")
    ends = _ev(raw, "round_end")
    freezes = sorted(int(t) for t in _ev(raw, "round_freeze_end")["tick"].tolist())

    match_start = 0
    if not starts.empty and "round" in starts:
        min_round = starts["round"].min()
        match_start = int(starts.loc[starts["round"] == min_round, "tick"].max())

    if ends.empty:
        return []
    valid = ends[ends["winner"].notna() & (ends["tick"] > match_start)].sort_values("tick")
    valid = valid.drop_duplicates(subset=["round"], keep="last").sort_values("tick")

    start_ticks = sorted(int(t) for t in starts["tick"].tolist()) if not starts.empty else []
    spans: list[_RoundSpan] = []
    prev_end = match_start
    for i, row in enumerate(valid.itertuples(index=False), start=1):
        end = int(row.tick)
        candidates = [t for t in start_ticks if prev_end <= t < end]
        start = candidates[-1] if candidates else prev_end
        fz = [t for t in freezes if start <= t < end]
        spans.append(_RoundSpan(i, start, fz[0] if fz else start, end, 0,
                                str(row.winner), None if pd.isna(row.reason) else str(row.reason)))
        prev_end = end
    for a, b in zip(spans, spans[1:]):
        a.next_start = b.start
    if spans:
        spans[-1].next_start = spans[-1].end + 10 ** 9
    return spans


def _round_of(spans: list[_RoundSpan], tick: int) -> int | None:
    for s in spans:
        if s.start <= tick < s.next_start:
            return s.number
    return None


def _snapshot_at(snap: pd.DataFrame, lo: int, hi: int, prefer: int | None = None) -> pd.DataFrame:
    """Lignes du premier instantané dans [lo, hi] (ou le plus proche de `prefer`)."""
    rows = snap[(snap["tick"] >= lo) & (snap["tick"] <= hi) & snap["team_num"].isin([2, 3])]
    if rows.empty:
        return rows
    ticks = sorted(rows["tick"].unique())
    tick = min(ticks, key=lambda t: abs(t - prefer)) if prefer is not None else ticks[0]
    return rows[rows["tick"] == tick]


# --------------------------------------------------------------------------- build

def build_demo(raw: RawDemo, opts: BuildOptions | None = None) -> ParsedDemo:
    opts = opts or BuildOptions()
    tr = raw.tickrate
    spans = compute_round_spans(raw)
    snap = raw.snapshots

    # --- appartenance des équipes
    side_players: dict[int, dict[str, set[str]]] = {}
    names: dict[str, str] = {}
    clan_votes: dict[int, dict[str, Counter]] = {}
    for s in spans:
        rows = _snapshot_at(snap, s.freeze_end, s.end, prefer=s.freeze_end)
        side_players[s.number] = {"CT": set(), "T": set()}
        clan_votes[s.number] = {"CT": Counter(), "T": Counter()}
        for r in rows.itertuples(index=False):
            sid = _sid(r.steamid)
            if sid is None:
                continue
            side = SIDE_BY_TEAMNUM[int(r.team_num)]
            side_players[s.number][side].add(sid)
            names[sid] = str(r.name)
            if isinstance(r.team_clan_name, str) and r.team_clan_name:
                clan_votes[s.number][side][r.team_clan_name] += 1

    team_members = {"A": set(), "B": set()}
    team_names = {"A": Counter(), "B": Counter()}
    ct_team: dict[int, str] = {}
    for s in spans:
        sp = side_players[s.number]
        if not team_members["A"] and not team_members["B"]:
            key_ct = "A"
        else:
            overlap_a = len(sp["CT"] & team_members["A"]) + len(sp["T"] & team_members["B"])
            overlap_b = len(sp["CT"] & team_members["B"]) + len(sp["T"] & team_members["A"])
            key_ct = "A" if overlap_a >= overlap_b else "B"
        key_t = "B" if key_ct == "A" else "A"
        ct_team[s.number] = key_ct
        team_members[key_ct] |= sp["CT"]
        team_members[key_t] |= sp["T"]
        team_names[key_ct].update(clan_votes[s.number]["CT"])
        team_names[key_t].update(clan_votes[s.number]["T"])

    teams = [PTeam("A", team_names["A"].most_common(1)[0][0] if team_names["A"] else "Équipe A"),
             PTeam("B", team_names["B"].most_common(1)[0][0] if team_names["B"] else "Équipe B")]

    players: list[PPlayer] = []
    seen: set[str] = set()
    for s in spans:
        for side in ("CT", "T"):
            key = ct_team[s.number] if side == "CT" else ("B" if ct_team[s.number] == "A" else "A")
            for sid in sorted(side_players[s.number][side]):
                if sid not in seen:
                    seen.add(sid)
                    players.append(PPlayer(sid, names.get(sid, sid), key, side))

    # --- rounds
    rounds: list[PRound] = []
    score = {"A": 0, "B": 0}
    for s in spans:
        key_ct = ct_team[s.number]
        key_t = "B" if key_ct == "A" else "A"
        buy_tick = min(s.freeze_end + int(opts.buy_time_s * tr), s.end)
        eq = _snapshot_at(snap, s.freeze_end, s.end, prefer=buy_tick)
        ct_val = int(eq.loc[eq["team_num"] == 3, "current_equip_value"].sum()) if not eq.empty else 0
        t_val = int(eq.loc[eq["team_num"] == 2, "current_equip_value"].sum()) if not eq.empty else 0
        rounds.append(PRound(
            number=s.number, start_tick=s.start, freeze_end_tick=s.freeze_end, end_tick=s.end,
            winner_side=s.winner, end_reason=s.reason, ct_team_key=key_ct, t_team_key=key_t,
            score_ct_before=score[key_ct], score_t_before=score[key_t],
            ct_equip_value=ct_val, t_equip_value=t_val,
            ct_buy_type=buy_type(s.number, ct_val, opts), t_buy_type=buy_type(s.number, t_val, opts),
        ))
        if s.winner == "CT":
            score[key_ct] += 1
        elif s.winner == "T":
            score[key_t] += 1

    demo = ParsedDemo(
        map_name=str(raw.header.get("map_name", "unknown")),
        server_name=str(raw.header.get("server_name", "")),
        tickrate=tr, sample_rate=raw.sample_rate, parser_version=PARSER_VERSION,
        teams=teams, players=players, rounds=rounds, score=score,
    )
    demo.kills = build_kills(raw, spans, opts)
    demo.damages = build_damages(raw, spans)
    demo.shots = build_shots(raw, spans)
    demo.grenades = build_grenades(raw, spans)
    demo.bomb_events = build_bomb_events(raw, spans)
    demo.purchases = build_purchases(raw, spans)
    demo.frames = build_frames(raw, spans, opts)
    demo.blinds = build_blinds(raw, demo.frames, demo.grenades, spans)
    return demo


# --------------------------------------------------------------------------- événements

def build_kills(raw: RawDemo, spans: list[_RoundSpan], opts: BuildOptions) -> list[PKill]:
    df = _ev(raw, "player_death").sort_values("tick")
    out: list[PKill] = []
    team_of: list[tuple[int, int | None, int | None]] = []  # (index, attacker_team, victim_team)
    for row in df.to_dict("records"):
        rn = _round_of(spans, int(row["tick"]))
        victim = _sid(row.get("user_steamid"))
        if rn is None or victim is None:
            continue
        attacker = _sid(row.get("attacker_steamid"))
        span = next(sp for sp in spans if sp.number == rn)
        if str(row.get("weapon") or "") == "world" and attacker in (None, victim) and int(row["tick"]) > span.end:
            continue  # morts « world » après la fin du round : joueurs retirés par le serveur en fin de match (FACEIT)
        out.append(PKill(
            round_number=rn, tick=int(row["tick"]), attacker=_sid(row.get("attacker_steamid")), victim=victim,
            assister=_sid(row.get("assister_steamid")), flash_assist=bool(row.get("assistedflash") or False),
            weapon=str(row.get("weapon") or ""), headshot=bool(row.get("headshot") or False),
            penetrated=int(_f(row.get("penetrated")) or 0), through_smoke=bool(row.get("thrusmoke") or False),
            noscope=bool(row.get("noscope") or False), attacker_blind=bool(row.get("attackerblind") or False),
            attacker_pos=_pos(row, "attacker_"), victim_pos=_pos(row, "user_") or (0.0, 0.0, 0.0),
            attacker_place=_place(row.get("attacker_last_place_name")), victim_place=_place(row.get("user_last_place_name")),
        ))
        at, vt = _f(row.get("attacker_team_num")), _f(row.get("user_team_num"))
        team_of.append((len(out) - 1, int(at) if at is not None else None, int(vt) if vt is not None else None))
        out[-1].attacker_side = SIDE_BY_TEAMNUM.get(int(at)) if at is not None else None
        out[-1].victim_side = SIDE_BY_TEAMNUM.get(int(vt)) if vt is not None else None
    mark_openings_and_trades(out, [t[1] for t in team_of], [t[2] for t in team_of],
                             int(opts.trade_window_s * raw.tickrate))
    return out


def mark_openings_and_trades(kills: list[PKill], attacker_teams: list[int | None],
                             victim_teams: list[int | None], window_ticks: int) -> None:
    """Marque is_opening (1er kill du round) et is_trade (on tue le tueur d'un coéquipier < fenêtre)."""
    seen_rounds: set[int] = set()
    for i, k in enumerate(kills):
        if k.round_number not in seen_rounds:
            seen_rounds.add(k.round_number)
            k.is_opening = True
        if k.attacker is None or k.attacker == k.victim:
            continue
        for j in range(i - 1, -1, -1):
            prev = kills[j]
            if prev.round_number != k.round_number or k.tick - prev.tick > window_ticks:
                break
            if prev.attacker == k.victim and victim_teams[j] is not None and victim_teams[j] == attacker_teams[i]:
                k.is_trade = True
                k.traded_player = prev.victim
                break


def build_damages(raw: RawDemo, spans: list[_RoundSpan]) -> list[PDamage]:
    out = []
    hp_before: dict[tuple[int, str], int] = {}
    for row in _ev(raw, "player_hurt").sort_values("tick").to_dict("records"):
        rn, victim = _round_of(spans, int(row["tick"])), _sid(row.get("user_steamid"))
        if rn is None or victim is None:
            continue
        dmg = int(_f(row.get("dmg_health")) or 0)
        before = hp_before.get((rn, victim), 100)
        after = int(_f(row.get("health")) or 0)
        hp_before[(rn, victim)] = after
        at, vt = _f(row.get("attacker_team_num")), _f(row.get("user_team_num"))
        out.append(PDamage(rn, int(row["tick"]), _sid(row.get("attacker_steamid")), victim,
                           str(row.get("weapon") or ""), dmg, int(_f(row.get("dmg_armor")) or 0),
                           str(row.get("hitgroup") or ""), dmg_health_real=max(0, min(dmg, before)),
                           attacker_side=SIDE_BY_TEAMNUM.get(int(at)) if at is not None else None,
                           victim_side=SIDE_BY_TEAMNUM.get(int(vt)) if vt is not None else None))
    return out


def build_shots(raw: RawDemo, spans: list[_RoundSpan]) -> list[PShot]:
    out = []
    for row in _ev(raw, "weapon_fire").to_dict("records"):
        weapon = str(row.get("weapon") or "")
        if any(w in weapon for w in NON_SHOT_WEAPONS):
            continue
        rn, shooter, pos = _round_of(spans, int(row["tick"])), _sid(row.get("user_steamid")), _pos(row, "user_")
        if rn is None or shooter is None or pos is None:
            continue
        vx, vy = _f(row.get("user_velocity_X")), _f(row.get("user_velocity_Y"))
        out.append(PShot(rn, int(row["tick"]), shooter, weapon.removeprefix("weapon_"), pos,
                         _f(row.get("user_yaw")) or 0.0, _f(row.get("user_pitch")) or 0.0,
                         speed=round(math.hypot(vx, vy), 1) if vx is not None and vy is not None else None))
    return out


def _place(v) -> str | None:
    return v if isinstance(v, str) and v else None


def build_grenades(raw: RawDemo, spans: list[_RoundSpan]) -> list[PGrenade]:
    g = raw.grenades
    if g is None or g.empty:
        return []
    det_events = {"smoke": "smokegrenade_detonate", "flash": "flashbang_detonate", "he": "hegrenade_detonate",
                  "decoy": "decoy_started"}
    # Les entity ids sont réutilisés pendant le match : on indexe par id -> liste triée par tick,
    # puis on choisit l'événement qui tombe dans la fenêtre temporelle de la grenade.
    def by_id(name: str) -> dict[int, list[dict]]:
        idx: dict[int, list[dict]] = {}
        for r in sorted(_ev(raw, name).to_dict("records"), key=lambda r: r["tick"]):
            if "entityid" in r and r["entityid"] is not None:
                idx.setdefault(int(r["entityid"]), []).append(r)
        return idx

    def first_in(rows: list[dict] | None, lo: int, hi: int) -> dict | None:
        return next((r for r in rows or [] if lo <= int(r["tick"]) <= hi), None)

    det_by_id = {gtype: by_id(ev) for gtype, ev in det_events.items()}
    end_by_id = {"smoke": by_id("smokegrenade_expired"), "decoy": by_id("decoy_detonate")}
    infernos = _ev(raw, "inferno_startburn").to_dict("records")
    inferno_end = by_id("inferno_expire")
    thrown = _ev(raw, "grenade_thrown").to_dict("records")
    throws = raw.throws
    throw_idx = {(int(r["tick"]), _sid(r["steamid"])): r for r in throws.to_dict("records")} if not throws.empty else {}
    used_infernos: set[tuple[int, int]] = set()
    max_life = {"smoke": 22, "molotov": 9, "incendiary": 9, "decoy": 20}  # secondes, si pas d'événement de fin

    # Un même entity id sert à plusieurs grenades successives : on découpe en segments de ticks contigus.
    g = g.sort_values(["grenade_entity_id", "tick"]).copy()
    gap = g.groupby("grenade_entity_id")["tick"].diff().fillna(0) > 8
    g["segment"] = gap.groupby(g["grenade_entity_id"]).cumsum()
    # segments = tranches contiguës (g est trié par id puis tick) : parcours par bornes sur des tableaux numpy,
    # bien plus rapide qu'un groupby pandas, dans le même ordre
    eids, segs = g["grenade_entity_id"].to_numpy(), g["segment"].to_numpy()
    gtypes, steamids = g["grenade_type"].to_numpy(), g["steamid"].to_numpy()
    tk, xs, ys, zs = (g[c].to_numpy() for c in ("tick", "x", "y", "z"))
    cuts = np.flatnonzero((eids[1:] != eids[:-1]) | (segs[1:] != segs[:-1])) + 1
    bounds = np.concatenate(([0], cuts, [len(g)])).tolist()
    out: list[PGrenade] = []
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        eid = eids[lo]
        gtype = GRENADE_TYPES.get(str(gtypes[lo]))
        thrower = _sid(steamids[lo])
        if gtype is None or thrower is None:
            continue
        t0, t1 = int(tk[lo]), int(tk[hi - 1])
        rn = _round_of(spans, t0)
        if rn is None:
            continue
        traj = list(zip(tk[lo:hi:2].tolist(), xs[lo:hi:2].tolist(), ys[lo:hi:2].tolist(), zs[lo:hi:2].tolist()))
        if traj[-1][0] != t1:
            traj.append((t1, float(xs[hi - 1]), float(ys[hi - 1]), float(zs[hi - 1])))
        tr_row = throw_idx.get((t0, thrower))
        throw_pos = _pos(tr_row, "") if tr_row is not None else None
        det_tick, det_pos, end_tick = None, None, None
        if gtype == "molotov":
            # Molotov vs incendiaire : arme du grenade_thrown le plus proche
            cand = [r for r in thrown if _sid(r.get("user_steamid")) == thrower and abs(int(r["tick"]) - t0) <= 8]
            if cand and "inc" in str(cand[0].get("weapon", "")):
                gtype = "incendiary"
            fires = [r for r in infernos if _sid(r.get("user_steamid")) == thrower
                     and t1 - 4 <= int(r["tick"]) <= t1 + 64
                     and (int(r["entityid"]), int(r["tick"])) not in used_infernos]
            if fires:
                f = fires[0]
                used_infernos.add((int(f["entityid"]), int(f["tick"])))
                det_tick, det_pos = int(f["tick"]), (float(f["x"]), float(f["y"]), float(f["z"]))
                e = first_in(inferno_end.get(int(f["entityid"])), det_tick, det_tick + 12 * raw.tickrate)
                end_tick = int(e["tick"]) if e else None
        else:
            d = first_in(det_by_id.get(gtype, {}).get(int(eid)), t0, t1 + raw.tickrate)
            if d is not None:
                det_tick, det_pos = int(d["tick"]), (float(d["x"]), float(d["y"]), float(d["z"]))
                if gtype in end_by_id:
                    e = first_in(end_by_id[gtype].get(int(eid)), det_tick, det_tick + 25 * raw.tickrate)
                    end_tick = int(e["tick"]) if e else None
                else:
                    end_tick = det_tick
        if det_tick is None:  # pas d'événement : la grenade « finit » à la fin de sa trajectoire
            det_tick, det_pos = t1, (traj[-1][1], traj[-1][2], traj[-1][3])
        if end_tick is None:  # fin manquante (ex. effacée par le changement de round)
            span = next(sp for sp in spans if sp.number == rn)
            end_tick = min(det_tick + max_life.get(gtype, 0) * raw.tickrate, span.next_start)
        out.append(PGrenade(
            round_number=rn, entity_id=int(eid), type=gtype, thrower=thrower, throw_tick=t0,
            throw_pos=throw_pos or (traj[0][1], traj[0][2], traj[0][3]),
            throw_yaw=_f(tr_row.get("yaw")) if tr_row is not None else None,
            throw_pitch=_f(tr_row.get("pitch")) if tr_row is not None else None,
            trajectory=traj, detonate_tick=det_tick, detonate_pos=det_pos, end_tick=end_tick,
        ))
    return out


def build_bomb_events(raw: RawDemo, spans: list[_RoundSpan]) -> list[PBombEvent]:
    out = []
    for ev, kind in (("bomb_pickup", "pickup"), ("bomb_dropped", "drop"), ("bomb_planted", "plant"),
                     ("bomb_defused", "defuse"), ("bomb_exploded", "explode")):
        for row in _ev(raw, ev).to_dict("records"):
            rn = _round_of(spans, int(row["tick"]))
            if rn is None:
                continue
            site = row.get("site")
            out.append(PBombEvent(rn, int(row["tick"]), kind, _sid(row.get("user_steamid")),
                                  None if site is None or pd.isna(site) else str(int(site)), _pos(row, "user_")))
    out.sort(key=lambda e: e.tick)
    return out


def build_purchases(raw: RawDemo, spans: list[_RoundSpan]) -> list[PPurchase]:
    out = []
    for row in _ev(raw, "item_purchase").to_dict("records"):
        if row.get("was_sold"):
            continue
        rn, sid = _round_of(spans, int(row["tick"])), _sid(row.get("steamid"))
        if rn is None or sid is None:
            continue
        out.append(PPurchase(rn, int(row["tick"]), sid, str(row.get("item_name") or ""), int(_f(row.get("cost")) or 0)))
    return out


# --------------------------------------------------------------------------- frames

def _truthy(col: pd.Series) -> np.ndarray:
    """Valeur de vérité Python de chaque cellule (NaN compte comme vrai, comme `if x:`), vectorisée si possible."""
    v = col.to_numpy()
    if v.dtype == bool:
        return v
    if np.issubdtype(v.dtype, np.number):
        return (v != 0) | np.isnan(v.astype(np.float64))
    return np.fromiter((bool(x) for x in v), dtype=bool, count=len(v))


def _num(df: pd.DataFrame, col: str, default: float) -> np.ndarray:
    """Colonne numérique facultative en float64 : absente (démo ancienne, fixture) ou NaN → `default`."""
    if col not in df.columns:
        return np.full(len(df), default, np.float64)
    v = pd.to_numeric(df[col], errors="coerce").to_numpy(np.float64, na_value=np.nan)
    return np.where(np.isnan(v), default, v)


def _on(df: pd.DataFrame, col: str) -> np.ndarray:
    """Colonne booléenne facultative : vraie seulement si présente et vraie (absente, None, NaN → faux)."""
    return _num(df, col, 0.0) != 0


def _to_ammo(v: np.ndarray) -> np.ndarray:
    """Munitions en uint16 ; inconnues (NaN, négatives ou -1 relu en uint32) → NO_AMMO."""
    ok = np.isfinite(v) & (v >= 0) & (v < NO_AMMO)
    return np.where(ok, np.where(ok, v, 0), NO_AMMO).astype(np.uint16)


def _ammo(df: pd.DataFrame, col: str) -> np.ndarray:
    """Munitions en uint16 ; inconnues (colonne absente, NaN, négatives ou -1 relu en uint32) → NO_AMMO."""
    return _to_ammo(_num(df, col, np.nan))


# Une réserve supérieure à ce nombre, vue sur une arme à chargeur, ne peut pas être un nombre de chargeurs : elle est en balles.
MAX_RESERVE_MAGS = 12
# ... mais une démo n'est « en balles » que si une part réelle des valeurs non nulles d'armes à chargeur la dépasse : au moins
# BULLETS_MIN_ROWS lignes ET au moins BULLETS_MIN_SHARE de ces valeurs. Une démo en balles en a l'essentiel (AK 90, USP-S 24,
# Glock 120 : 90 % et plus, mesuré sur Vitality-FaZe) et une démo en chargeurs aucune (max 4 sur G2-Astralis) : tout seuil
# entre les deux convient ; 1 % et 3 lignes écartent une valeur isolée (Zeus à 90…) sans manquer une petite démo en balles.
BULLETS_MIN_ROWS = 3
BULLETS_MIN_SHARE = 0.01


def _known_f32(t: pd.DataFrame, col: str) -> np.ndarray:
    """Colonne numérique en float32 (exact jusqu'à 2^24, bien au-dessus des munitions) : NaN si la colonne est absente,
    NaN, négative ou -1 relu en uint32 (même règle que _to_ammo)."""
    if col not in t.columns:
        return np.full(len(t), np.nan, np.float32)
    a = pd.to_numeric(t[col], errors="coerce").to_numpy(np.float32, na_value=np.nan)
    return np.where((a >= 0) & (a < NO_AMMO), a, np.float32(np.nan))


def _reserve_mags(t: pd.DataFrame, spans: list[_RoundSpan], post: int) -> np.ndarray:
    """Réserve de munitions de l'arme tenue, en CHARGEURS de rechange (uint16, NO_AMMO = inconnue), une valeur par ligne
    de `t` (colonnes tick, sid, active_weapon_name, active_weapon_ammo, total_ammo_left).

    Ce que la démo donne dans total_ammo_left, vérifié sur 4 démos (patchs 14103 à 14174) :
    - une arme reste à 0 tant que son entité n'a pas été mise à jour (fin d'un premier rechargement, ou remplissage au
      début d'un round) : ces 0 de tête sont faux (une AK pleine à 0). Une valeur non nulle ne revient à 0 que si la
      réserve est vraiment vide ;
    - l'unité dépend du patch : en balles jusqu'au 14135 (AK pleine 90), en chargeurs au 14174 (AK pleine 3).

    1. Unité, décidée pour toute la démo par les données (le numéro de patch de l'en-tête dit quand le jeu a changé, pas
       ce que contient cette démo-ci) : une part réelle des valeurs non nulles d'armes à chargeur > MAX_RESERVE_MAGS (12)
       veut dire « en balles » (seuils : BULLETS_MIN_*). Les chargeurs pleins sont alors plancher(réserve / plus grand
       chargeur vu pour ce nom d'arme dans la démo), au moins 1 si la réserve n'est pas vide (72 balles d'AK : 2, comme le
       14174 ; un chargeur entamé ne disparaît pas), sans table d'armes. Sinon la démo est déjà en chargeurs : valeur telle quelle.
    2. Période : un joueur, un round, une arme (passer au couteau puis revenir ne change pas sa réserve ; une baisse de la
       réserve sans hausse du chargeur est une autre arme du même nom : nouvelle période). Les 0 avant
       la première valeur non nulle de la période prennent cette valeur ; si elle arrive à la fin d'un rechargement
       (hausse du chargeur à ce tick), la réserve d'avant était plus pleine : + 1 chargeur (démo en chargeurs) ou + la
       hausse du chargeur en balles (démo en balles). Un 0 qui suit une valeur non nulle reste 0.
    3. Une période sans aucune valeur non nulle (arme jamais rechargée du round) prend la réserve pleine de cette arme
       dans la démo : le plus grand de ses états d'avant rechargement et de ses valeurs. Arme jamais non nulle dans
       toute la démo (Deagle, FAMAS…) : inconnue, jamais 0.
    Les lignes sans chargeur (couteau, grenades, C4) et celles hors des rounds gardent leur valeur brute.

    Limites (indiscernables dans les données) : une AK ramassée dont le chargeur est plus plein que le précédent garde son 0
    de tête comme un vrai 0 ; une période sans valeur non nulle est remplie de la réserve pleine même si, après un rechargement,
    elle vaudrait 0 ; un NaN entre deux valeurs empêche de voir une baisse.

    Mémoire : float32 et petits entiers, les calculs lourds sur les seules lignes d'armes à chargeur des rounds."""
    val = _known_f32(t, "total_ammo_left")  # complété en place plus bas : c'est aussi le résultat
    if not np.isfinite(val).any() or not {"active_weapon_name", "active_weapon_ammo"} <= set(t.columns):
        return _to_ammo(val)

    names = t["active_weapon_name"]
    if isinstance(names.dtype, pd.CategoricalDtype):  # comme en production (CATEGORY_COLUMNS) : les codes, sans hacher les textes
        name, n_names = names.cat.codes.to_numpy(), len(names.cat.categories)
    else:
        codes, uniq = pd.factorize(names)
        name, n_names = codes.astype(np.int32), len(uniq)
    del names
    clip = _known_f32(t, "active_weapon_ammo")
    # plus grand chargeur vu pour chaque nom (0 : jamais de chargeur) ; une case de plus à la fin : le code -1 (pas d'arme) l'adresse
    biggest = np.zeros(n_names + 1, np.float32)
    seen = (name >= 0) & ~np.isnan(clip)
    mx = pd.Series(clip[seen]).groupby(name[seen]).max()
    biggest[mx.index.to_numpy()] = mx.to_numpy()
    del seen, mx
    gun = (biggest >= 1)[name]  # armes à chargeur (couteau, grenades, C4 : non)
    fire = gun & (val > 0)
    n_fire, n_big = int(fire.sum()), int((fire & (val > MAX_RESERVE_MAGS)).sum())
    del fire
    bullets = n_big >= BULLETS_MIN_ROWS and n_big >= BULLETS_MIN_SHARE * n_fire

    # période de chaque ligne : (round, joueur, arme) ; les lignes hors des rounds n'en ont pas
    sidc = pd.factorize(t["sid"])[0].astype(np.int32)
    g = np.flatnonzero(gun & (sidc >= 0))
    del gun
    tick = t["tick"].to_numpy()
    idx = g[:0]
    if spans and len(g):
        starts = np.array([s.start for s in spans], tick.dtype)
        his = np.array([min(s.next_start, s.end + post) for s in spans], np.int64)
        o = np.argsort(starts, kind="stable")
        k = np.searchsorted(starts[o], tick[g], side="right") - 1
        rid = o[np.maximum(k, 0)]
        inside = (k >= 0) & (tick[g] < his[rid])
        idx, rid = g[inside], rid[inside].astype(np.int64)
        del k, inside
    del g
    full = np.full(n_names + 1, np.nan, np.float32)  # réserve pleine de chaque arme, dans l'unité de la démo
    if len(idx):
        key = (rid * (int(sidc.max()) + 1) + sidc[idx]) * (n_names + 1) + name[idx]
        seg = pd.factorize(key)[0]
        del key, rid
        o = np.lexsort((tick[idx], seg))  # par période, puis par tick (stable)
        idx, seg = idx[o], seg[o]
        del o
        v, c, nm = val[idx], clip[idx], name[idx]
        # Une réserve ne baisse qu'à la fin d'un rechargement (le chargeur monte). Une baisse sans hausse du chargeur
        # (une AK à 90 puis à 0) est une AUTRE arme du même nom ramassée ou achetée dans le round : nouvelle période.
        drop = (seg[1:] == seg[:-1]) & (v[1:] < v[:-1]) & ~(c[1:] > c[:-1])
        seg = pd.factorize(seg + np.cumsum(np.r_[False, drop]))[0]
        nz = v > 0
        cum = pd.Series(nz.astype(np.int32)).groupby(seg).cumsum().to_numpy()  # valeurs non nulles vues, cette ligne comprise
        first = nz & (cum == 1)
        same = np.r_[False, seg[1:] == seg[:-1]]
        nan = np.float32(np.nan)
        rise = np.where(same, c - np.r_[nan, c[:-1]], nan)  # hausse du chargeur depuis la ligne précédente de la période
        reloaded = first & (rise > 0) & (rise <= biggest[nm])
        before = np.where(reloaded, v + (rise if bullets else np.float32(1.0)), v)  # réserve d'avant le rechargement
        start = np.full(seg.max() + 1, nan, np.float32)
        start[seg[first]] = before[first]
        lead = (cum == 0) & (v == 0)  # 0 de tête : avant la première valeur non nulle de la période
        val[idx[lead]] = start[seg[lead]]
        fm = pd.Series(np.where(first, before, v)).groupby(nm).max()  # réserve pleine : le plus grand état vu pour l'arme
        full[fm.index.to_numpy()] = fm.to_numpy()
        full[full <= 0] = np.nan
        none = ~np.isin(seg, seg[nz]) & (v == 0)  # période sans aucune valeur non nulle
        val[idx[none]] = full[nm[none]]
    if bullets:
        r = np.flatnonzero((biggest >= 1)[name] & (val > 0))  # réserve non vide d'une arme à chargeur
        val[r] = np.maximum(np.float32(1.0), np.floor(val[r] / biggest[name[r]]))
    return _to_ammo(val)


def _crosshairs(t: pd.DataFrame) -> dict[str, str]:
    """Premier code de réticule non vide de chaque joueur, dans l'ordre des ticks (un seul par joueur en pratique)."""
    if "crosshair_code" not in t.columns:
        return {}
    code = t["crosshair_code"]  # texte ou catégorie (extract_raw) : ni fillna ni astype sur toute la colonne
    c = t.loc[code.notna() & code.ne(""), ["tick", "sid", "crosshair_code"]]
    c = c.sort_values("tick", kind="stable").drop_duplicates("sid")
    return dict(zip(c["sid"], c["crosshair_code"].astype(str), strict=True))


def _viewmodels(rt: pd.DataFrame, players: list[str]) -> list[list[float] | None]:
    """Réglages des bras de chaque joueur (ordre de `players`) : [viewmodel_fov, offset x, y, z] à 2 décimales, le réglage
    le plus fréquent parmi les lignes du joueur dans le round (égalité : le plus petit). Une ligne à NaN ou sans
    viewmodel_fov positif (le jeu le borne entre 54 et 68) est ignorée ; aucune ligne exploitable, ou colonnes absentes
    (démo ancienne) → None."""
    v = np.column_stack([np.round(_num(rt, c, np.nan), 2) for c in VIEWMODEL_PROPS])
    ok = ~np.isnan(v).any(axis=1) & (v[:, 0] > 0)
    if not ok.any():
        return [None] * len(players)
    keys = ["fov", "x", "y", "z"]
    rows = pd.DataFrame(v[ok], columns=keys).assign(sid=rt["sid"].to_numpy()[ok])
    counts = rows.groupby(["sid", *keys]).size().reset_index(name="n")
    best = counts.sort_values(["sid", "n", *keys], ascending=[True, False, True, True, True, True]).drop_duplicates("sid")
    found = {r.sid: [float(r.fov), float(r.x), float(r.y), float(r.z)] for r in best.itertuples(index=False)}
    return [found.get(p) for p in players]


def _agents(rt: pd.DataFrame, players: list[str]) -> list[str | None]:
    """Agent équipé par chaque joueur dans le round (ordre de `players`) : nom du modèle (« tm_leet_variantf »), le plus
    fréquent parmi ses lignes (égalité : le premier par ordre alphabétique). Agent par défaut (« customplayer_*_map_based »),
    valeur vide ou colonne absente (démo ancienne) → None."""
    if "agent_skin" not in rt.columns:
        return [None] * len(players)
    a = rt["agent_skin"].astype("string")  # texte ou catégorie (extract_raw)
    ok = (a.str.startswith("customplayer_") & ~a.str.endswith("_map_based")).fillna(False).to_numpy(bool)
    if not ok.any():
        return [None] * len(players)
    rows = pd.DataFrame({"sid": rt["sid"].to_numpy()[ok], "agent": a[ok].str.removeprefix("customplayer_").to_numpy()})
    counts = rows.groupby(["sid", "agent"]).size().reset_index(name="n")
    best = counts.sort_values(["sid", "n", "agent"], ascending=[True, False, True]).drop_duplicates("sid")
    found = dict(zip(best["sid"], best["agent"], strict=True))
    return [found.get(p) for p in players]


@dataclass
class _MidAngles:
    """Angles lus aux ticks du milieu (RawDemo.angles), triés par tick : joueur en code entier (`codes`), sans texte."""
    tick: np.ndarray  # int64
    code: np.ndarray  # int32, indice dans `codes`
    yaw: np.ndarray  # float32
    pitch: np.ndarray  # float32
    codes: dict[str, int]


def _mid_angles(angles: pd.DataFrame) -> _MidAngles | None:
    """RawDemo.angles en tableaux numpy triés par tick ; None s'il n'y en a pas (démo ancienne, une image par tick)."""
    if angles is None or angles.empty:
        return None
    order = np.argsort(angles["tick"].to_numpy(np.int64), kind="stable")
    ids = {v: _sid(v) for v in angles["steamid"].unique()}
    codes = {s: k for k, s in enumerate(sorted({s for s in ids.values() if s is not None}))}
    code = angles["steamid"].map({v: codes.get(s, -1) for v, s in ids.items()}).to_numpy(np.int32)
    return _MidAngles(angles["tick"].to_numpy(np.int64)[order], code[order],
                      angles["yaw"].to_numpy(np.float32)[order], angles["pitch"].to_numpy(np.float32)[order], codes)


def _mid_fields(f: dict[str, np.ndarray], ticks: np.ndarray, players: list[str], a: _MidAngles, lo: int, hi: int,
                step: int) -> dict[str, np.ndarray]:
    """Champs « yawm » et « pitchm » (n_images × n_joueurs, float32) : lacet et angle vertical au tick du milieu qui suit
    chaque image (mid_tick_offset). Sans échantillon pour un joueur, ou si l'image suivante n'est pas à un pas exactement
    (trou dans les images), le milieu des deux images voisines : lacet par le chemin court, ramené dans (-180, 180], angle
    vertical en moyenne. Le moteur interpole alors comme sans échantillon du milieu. Dernière image : sa propre valeur."""
    n = len(ticks)
    yaw, pitch = f["yaw"].astype(np.float64), f["pitch"].astype(np.float64)
    ym, pm = yaw.copy(), pitch.copy()
    if n > 1:
        d = (yaw[1:] - yaw[:-1] + 180.0) % 360.0 - 180.0  # [-180, 180[ ; -180 compte comme +180, comme lerpAngle du moteur
        ym[:-1] = yaw[:-1] + np.where(d == -180.0, 180.0, d) / 2.0
        pm[:-1] = (pitch[:-1] + pitch[1:]) / 2.0
        ym = np.where(ym > 180.0, ym - 360.0, np.where(ym <= -180.0, ym + 360.0, ym))
    off = mid_tick_offset(step)
    s, e = np.searchsorted(a.tick, [lo, hi])  # échantillons du round, par tranche (a.tick est trié)
    base = a.tick[s:e] - off  # tick de l'image qui précède l'échantillon
    i = np.minimum(np.searchsorted(ticks, base), n - 1)
    nxt = np.minimum(i + 1, n - 1)
    lut = np.full(len(a.codes), -1, np.int64)
    for j, p in enumerate(players):
        if p in a.codes:
            lut[a.codes[p]] = j
    code = a.code[s:e]
    j = np.where(code >= 0, lut[np.maximum(code, 0)], -1)
    yaw_a, pitch_a = a.yaw[s:e], a.pitch[s:e]
    ok = (ticks[i] == base) & (i < n - 1) & (ticks[nxt] - ticks[i] == step) & (j >= 0) & ~np.isnan(yaw_a) & ~np.isnan(pitch_a)
    ym[i[ok], j[ok]] = yaw_a[ok]
    pm[i[ok], j[ok]] = pitch_a[ok]
    return {"yawm": ym.astype(np.float32), "pitchm": pm.astype(np.float32)}


def _gun_shots(raw: RawDemo) -> pd.DataFrame:
    """Tirs d'armes à feu avec le recul de la caméra du tireur (tick, sid, punch_pitch, punch_yaw) et son recul de visée
    (aim_pitch, aim_yaw ; NaN s'il n'a pas été lu, ou dans une extraction d'avant), un par (tick, joueur), sans couteau ni
    grenades (comme build_shots) ; les tirs dont le recul de la caméra n'a pas été lu sont absents. Vide si aucun."""
    fire, punch = raw.events.get("weapon_fire"), raw.punch
    if fire is None or fire.empty or punch is None or punch.empty or "weapon" not in fire.columns:
        return pd.DataFrame(columns=["tick", "sid", "punch_pitch", "punch_yaw", "aim_pitch", "aim_yaw"])
    gun = ~fire["weapon"].fillna("").astype(str).map(lambda w: any(x in w for x in NON_SHOT_WEAPONS)).to_numpy(bool)
    fires = fire.loc[gun, ["tick", "user_steamid"]]

    def sid_of(col: pd.Series) -> np.ndarray:  # chacun avec ses propres valeurs : uint64 et int64 passeraient par float64
        return col.map({v: _sid(v) for v in col.unique()}).to_numpy(object)

    shots = pd.DataFrame({"tick": fires["tick"].to_numpy(np.int64), "sid": sid_of(fires["user_steamid"])})
    aim = {c: punch[c].to_numpy(np.float32) if c in punch.columns else np.full(len(punch), np.nan, np.float32)
           for c in ("aim_pitch", "aim_yaw")}
    got = pd.DataFrame({"tick": punch["tick"].to_numpy(np.int64), "sid": sid_of(punch["steamid"]),
                        "punch_pitch": punch["punch_pitch"].to_numpy(np.float32),
                        "punch_yaw": punch["punch_yaw"].to_numpy(np.float32), **aim})
    got = got.dropna(subset=["tick", "sid", "punch_pitch", "punch_yaw"])
    out = shots.dropna().merge(got, on=["tick", "sid"]).drop_duplicates(["tick", "sid"])
    return out.sort_values("tick", kind="stable").reset_index(drop=True)


def _death_forces(raw: RawDemo) -> pd.DataFrame:
    """Force de la mort lue à l'analyse (tick, sid, fx, fy, fz), une par (tick, victime), par ordre de tick ; vide si elle
    n'a pas été lue (démo sans la prop, extraction d'avant le ragdoll) ou si elle est illisible (NaN)."""
    f = raw.forces
    if f is None or f.empty or not {"tick", "steamid", "fx", "fy", "fz"} <= set(f.columns):
        return pd.DataFrame(columns=["tick", "sid", "fx", "fy", "fz"])
    sid = f["steamid"].map({v: _sid(v) for v in f["steamid"].unique()}).to_numpy(object)
    out = pd.DataFrame({"tick": f["tick"].to_numpy(np.int64), "sid": sid,
                        **{c: f[c].to_numpy(np.float32) for c in ("fx", "fy", "fz")}})
    out = out.dropna().drop_duplicates(["tick", "sid"])
    return out.sort_values("tick", kind="stable").reset_index(drop=True)


def _round_forces(forces: pd.DataFrame, pi: dict[str, int], lo: int, hi: int) -> list[list[int | float]]:
    """Forces des morts du round entre les ticks lo (inclus) et hi (exclu) : [tick, indice du joueur, fx, fy, fz] arrondies
    au dixième (-0 ramené à 0), par ordre de tick puis de joueur ; victimes absentes du round écartées."""
    if forces.empty:
        return []
    rs = forces[(forces["tick"] >= lo) & (forces["tick"] < hi)]
    j = rs["sid"].map(pi)
    rs, j = rs[j.notna()], j.dropna().astype(int)
    rows = sorted(zip(rs["tick"].tolist(), j.tolist(), rs["fx"].tolist(), rs["fy"].tolist(), rs["fz"].tolist(), strict=True),
                  key=lambda r: (r[0], r[1]))

    def r1(v: float) -> float:
        return round(float(v), 1) + 0.0

    return [[int(t), int(k), r1(x), r1(y), r1(z)] for t, k, x, y, z in rows]


def _round_punch(shots: pd.DataFrame, pi: dict[str, int], lo: int, hi: int) -> list[list[int | float]]:
    """Tirs du round entre les ticks lo (inclus) et hi (exclu) : [tick, indice du joueur, vertical, horizontal], plus
    [visée verticale, visée horizontale] si le recul de visée a été lu ; reculs arrondis au millième de degré (-0 ramené
    à 0), par ordre de tick puis de joueur ; tireurs absents du round écartés."""
    if shots.empty:
        return []
    rs = shots[(shots["tick"] >= lo) & (shots["tick"] < hi)]
    j = rs["sid"].map(pi)
    rs, j = rs[j.notna()], j.dropna().astype(int)
    rows = sorted(zip(rs["tick"].tolist(), j.tolist(), rs["punch_pitch"].tolist(), rs["punch_yaw"].tolist(),
                      rs["aim_pitch"].tolist(), rs["aim_yaw"].tolist(), strict=True), key=lambda r: (r[0], r[1]))

    def r3(v: float) -> float:
        return round(float(v), 3) + 0.0

    return [[int(t), int(k), r3(p), r3(y), *([] if np.isnan(ap) or np.isnan(ay) else [r3(ap), r3(ay)])]
            for t, k, p, y, ap, ay in rows]


def _reserve_or_raw(t: pd.DataFrame, spans: list[_RoundSpan], post: int) -> np.ndarray:
    """_reserve_mags, gardé : il tourne sur toutes les démos de la bibliothèque, et une exception sur une démo inattendue
    mettrait toute son analyse en « error » (pas relancée au démarrage suivant). En cas d'échec, la réserve reprend la
    colonne brute comme avant la correction (0 de tête et unité de la démo gardés ; colonne absente : NO_AMMO), avec un
    avertissement au journal, et l'analyse continue."""
    try:
        return _reserve_mags(t, spans, post)
    except Exception:  # une réserve moins juste vaut mieux qu'une démo en « error »
        log.warning("Réserve en chargeurs illisible : réserve brute de la démo gardée", exc_info=True)
        return _ammo(t, "total_ammo_left")


def build_frames(raw: RawDemo, spans: list[_RoundSpan], opts: BuildOptions) -> dict[int, PRoundFrames]:
    """Images échantillonnées par round, construites en vectoriel (numpy) : même résultat que la version ligne à ligne,
    plusieurs fois plus rapide sur une démo complète (~500 000 lignes)."""
    t = raw.ticks
    if t is None or t.empty:
        return {}
    # une seule copie du tableau, pas trois : lignes des deux équipes dont le steamid donne un identifiant
    sids = {v: _sid(v) for v in t["steamid"].unique()}
    valid = t["team_num"].isin([2, 3]).to_numpy() & t["steamid"].isin([v for v, s in sids.items() if s is not None]).to_numpy()
    t = t.take(np.flatnonzero(valid))
    t["sid"] = t["steamid"].map(sids)
    weapons: list[str] = []
    widx: dict[str, int] = {}
    inv_ids: dict[tuple, list[int]] = {}
    xhair_of = _crosshairs(t)
    step = frame_step(raw.tickrate, raw.sample_rate)
    mid = _mid_angles(raw.angles) if mid_tick_offset(step) else None  # regard entre deux images (tâche 1.10)
    shots = _gun_shots(raw)  # tirs avec le recul de la caméra (tâche 1.10)
    forces = _death_forces(raw)  # force de la mort (ragdoll du replay 3D)
    t["reserve_mags"] = _reserve_or_raw(t, spans, int(opts.post_round_s * raw.tickrate))  # réserve en chargeurs, 0 de tête corrigés

    def wid(name) -> int:
        n = name if isinstance(name, str) else ""
        if n not in widx:
            widx[n] = len(weapons)
            weapons.append(n)
        return widx[n]

    def clip_int(col: pd.Series, hi: int) -> np.ndarray:
        return np.clip(col.fillna(0).to_numpy(np.float64), 0, hi).astype(np.int64)

    out: dict[int, PRoundFrames] = {}
    post = int(opts.post_round_s * raw.tickrate)
    for s in spans:
        hi = min(s.next_start, s.end + post)
        rt = t[(t["tick"] >= s.start) & (t["tick"] < hi)]
        if rt.empty:
            continue
        ticks = np.array(sorted(rt["tick"].unique()), dtype=np.int32)
        players = sorted(rt["sid"].unique().tolist())
        n, m = len(ticks), len(players)
        pi = {p: k for k, p in enumerate(players)}
        ii = np.searchsorted(ticks, rt["tick"].to_numpy())
        jj = rt["sid"].map(pi).to_numpy(np.int64)
        f = {
            "x": np.zeros((n, m), np.float32), "y": np.zeros((n, m), np.float32), "z": np.zeros((n, m), np.float32),
            "yaw": np.zeros((n, m), np.float32), "hp": np.zeros((n, m), np.uint8), "armor": np.zeros((n, m), np.uint8),
            "flags": np.zeros((n, m), np.uint8), "weapon": np.zeros((n, m), np.uint16),
            "money": np.zeros((n, m), np.uint16), "flash": np.zeros((n, m), np.float32),
            "equip": np.zeros((n, m), np.uint16),
            # vue du joueur (PARSER_VERSION 3)
            "pitch": np.zeros((n, m), np.float32), "duck": np.zeros((n, m), np.uint8),
            "clip": np.full((n, m), NO_AMMO, np.uint16), "reserve": np.full((n, m), NO_AMMO, np.uint16),
            "zoom": np.zeros((n, m), np.uint8), "keys": np.zeros((n, m), np.uint16),
            "fov": np.zeros((n, m), np.uint8),
        }
        # numérotation des armes dans l'ordre de première apparition (arme active puis inventaire, sur toutes les
        # lignes dans l'ordre), identique à la version ligne à ligne : les indices stockés ne changent pas
        # un inventaire déjà vu a déjà numéroté toutes ses armes : le cache ne change pas l'ordre des indices.
        # Les listes d'indices sont partagées entre cellules (lecture seule, seul encode_frames les lit).
        inventories = [() if x is None else tuple(x.tolist() if isinstance(x, np.ndarray) else x)
                       for x in rt["inventory"].tolist()]
        active = rt["active_weapon_name"].tolist()
        empty: list[int] = []
        inv: list[list[list[int]]] = [[empty] * m for _ in range(n)]
        wcol = np.empty(len(active), np.int64)
        for k, (i, j, a, items) in enumerate(zip(ii.tolist(), jj.tolist(), active, inventories)):
            wcol[k] = wid(a)
            ids = inv_ids.get(items)
            if ids is None:
                ids = inv_ids[items] = [wid(x) for x in items]
            inv[i][j] = ids
        # en cas de doublon (même tick, même joueur), la dernière ligne l'emporte, comme dans la boucle d'origine
        last = ~pd.Series(ii * max(1, m) + jj).duplicated(keep="last").to_numpy()
        ii, jj, rl = ii[last], jj[last], rt[last]
        for key, col in (("x", "X"), ("y", "Y"), ("z", "Z"), ("yaw", "yaw"), ("flash", "flash_duration")):
            v = rl[col]
            f[key][ii, jj] = v.fillna(0).to_numpy(np.float64) if v.dtype == object else v.to_numpy(np.float64)
        f["hp"][ii, jj] = clip_int(rl["health"], 255)
        f["armor"][ii, jj] = clip_int(rl["armor_value"], 255)
        f["money"][ii, jj] = clip_int(rl["balance"], 65535)
        f["equip"][ii, jj] = clip_int(rl["current_equip_value"], 65535)
        f["weapon"][ii, jj] = wcol[last]
        f["pitch"][ii, jj] = _num(rl, "pitch", 0.0)  # degrés, positif = regard vers le bas (convention CS2)
        f["duck"][ii, jj] = np.clip(np.round(_num(rl, "duck_amount", 0.0) * 255), 0, 255)
        f["clip"][ii, jj] = _ammo(rl, "active_weapon_ammo")
        f["reserve"][ii, jj] = rl["reserve_mags"].to_numpy(np.uint16)  # chargeurs de rechange (_reserve_mags)
        f["zoom"][ii, jj] = np.clip(_num(rl, "zoom_lvl", 0.0), 0, 255)
        f["fov"][ii, jj] = np.clip(np.round(_num(rl, FOV_PROP, 0.0)), 0, 255)  # 0 = défaut du jeu (90) ou inconnu
        keys = np.zeros(len(rl), np.uint16)
        for col, bit in KEY_COLUMNS:
            keys |= np.where(_on(rl, col), bit, 0).astype(np.uint16)
        f["keys"][ii, jj] = keys
        bomb = np.fromiter(("C4 Explosive" in x for x in inventories), dtype=bool, count=len(inventories))[last]
        f["flags"][ii, jj] = (np.where(_truthy(rl["is_alive"]), FLAG_ALIVE, 0) | np.where(_truthy(rl["has_helmet"]), FLAG_HELMET, 0)
                              | np.where(_truthy(rl["has_defuser"]), FLAG_DEFUSER, 0)
                              | np.where(_truthy(rl["is_defusing"]), FLAG_DEFUSING, 0)
                              | np.where(_truthy(rl["is_scoped"]), FLAG_SCOPED, 0) | np.where(bomb, FLAG_BOMB, 0)
                              | np.where(_on(rl, "is_airborne"), FLAG_AIRBORNE, 0)
                              | np.where(_num(rl, MOVETYPE_PROP, 0.0) == MOVETYPE_LADDER, FLAG_LADDER, 0))
        _fill_missing_positions(f)
        if mid is not None:
            f |= _mid_fields(f, ticks, players, mid, s.start, hi, step)
        out[s.number] = PRoundFrames(s.number, ticks, players, f, weapons, inv, [xhair_of.get(p) for p in players],
                                     _viewmodels(rt, players), _round_punch(shots, pi, s.start, hi), _agents(rt, players),
                                     _round_forces(forces, pi, s.start, hi))
    return out


def _fill_missing_positions(f: dict[str, np.ndarray]) -> None:
    """Ticks où un joueur est absent (déconnexion) : on recopie la dernière position connue."""
    present = (f["x"] != 0) | (f["y"] != 0)
    n = present.shape[0]
    idx = np.where(present, np.arange(n)[:, None], -1)
    np.maximum.accumulate(idx, axis=0, out=idx)  # dernier indice présent à chaque tick
    fill = ~present & (idx >= 0)
    if not fill.any():
        return
    src_i, cols = idx[fill], np.nonzero(fill)[1]
    for k in ("x", "y", "z", "yaw", "pitch"):
        f[k][fill] = f[k][src_i, cols]


def build_blinds(raw: RawDemo, frames: dict[int, PRoundFrames], grenades: list[PGrenade],
                 spans: list[_RoundSpan]) -> list[PBlind]:
    """Aveuglements déduits de la hausse de flash_duration dans les frames, attribués à la flash la plus récente."""
    flashes = sorted((g.detonate_tick, g.thrower) for g in grenades if g.type == "flash" and g.detonate_tick)
    win = raw.tickrate // 2 + frame_step(raw.tickrate, raw.sample_rate)
    out = []
    for rn, fr in frames.items():
        fl = fr.fields["flash"]
        for i in range(1, fl.shape[0]):
            for j, sid in enumerate(fr.players):
                if fl[i, j] > fl[i - 1, j] + 0.3:
                    tick = int(fr.ticks[i])
                    cands = [th for (dt, th) in flashes if 0 <= tick - dt <= win]
                    out.append(PBlind(rn, tick, cands[-1] if cands else None, sid, float(fl[i, j])))
    return out
