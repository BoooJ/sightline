# backend/app/stats/tactics.py
"""Playbook v2 (comme le Playbook d'EDGE) : des tactiques définies par l'équipe, détectées dans chaque round.

Une tactique = carte + camp + conditions, toutes à satisfaire :
- `players_in_zone`  : au moins `min_players` de nos joueurs vivants dans un polygone (coordonnées monde) pendant
                        la fenêtre `[from_s, to_s]` après le freeze time ;
- `utility_in_zone`  : au moins `min_count` grenades de nos joueurs (types choisis) qui atterrissent (ou sont lancées,
                        `position: "throw"`) dans le polygone pendant la fenêtre ;
- `bomb_planted`     : pose (sur `site` si donné) avant `before_s` ;
- `contact_before`   : premier contact (dégâts entre camps) avant `s` ;
- `no_contact_before`: aucun contact avant `s`.
La tactique est « utilisée » quand toutes les conditions sont vraies ; son instant = celui où la dernière devient vraie
(séquence du round). Les quatre classes automatiques (rush, exécution, default, eco) restent comme tactiques intégrées."""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.parsing.model import FLAG_ALIVE
from app.stats.playbook import team_playbook
from app.storage.frames_codec import decode_fields
from app.storage.labels import match_date
from app.storage.models import BombEvent, Damage, Grenade, Match, Round, RoundFrames, Tactic

CATEGORIES: list[tuple[str, str]] = [
    ("mid_round", "Mid round"), ("set_strat", "Set strat"), ("rush", "Rush"), ("default", "Default"),
    ("map_control", "Contrôle de carte"), ("utility", "Utilitaire"), ("boost", "Boost"), ("set_control", "Set strat (contrôle)"),
]
CATEGORY_LABELS = dict(CATEGORIES)
CONDITION_KINDS = ("players_in_zone", "utility_in_zone", "bomb_planted", "contact_before", "no_contact_before")
GRENADE_TYPES = ("smoke", "flash", "he", "molotov", "incendiary", "decoy")
ROUND_S = 115
TIME_BUCKETS: list[tuple[str, float, float]] = [("1:55-1:30", 0, 25), ("1:29-1:05", 25, 50), ("1:04-0:35", 50, 80), ("0:34-0:00", 80, 999)]
# tactiques intégrées : classes automatiques du playbook v1
BUILTIN = {
    "auto:rush": {"name": "Rush (auto)", "category": "rush", "side": "T"},
    "auto:execute": {"name": "Exécution (auto)", "category": "set_strat", "side": "T"},
    "auto:default": {"name": "Default (auto)", "category": "default", "side": "T"},
    "auto:eco": {"name": "Eco (auto)", "category": "default", "side": "T"},
    "auto:split": {"name": "Split (auto)", "category": "set_strat", "side": "T"},
    "auto:fake": {"name": "Fake (auto)", "category": "set_strat", "side": "T"},
}


def _point_in_poly(x: float, y: float, poly: list[list[float]]) -> bool:
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / ((y2 - y1) or 1e-9)
            if x < xi:
                inside = not inside
    return inside


def _inside(poly: list[list[float]], X: np.ndarray, Y: np.ndarray) -> np.ndarray:
    """Appartenance au polygone, vectorisée (ray casting) pour des tableaux de points."""
    out = np.zeros(X.shape, dtype=bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cond = (y1 > Y) != (y2 > Y)
        xi = x1 + (Y - y1) * (x2 - x1) / ((y2 - y1) or 1e-9)
        out ^= cond & (X < xi)
    return out


def clean_definition(raw: dict) -> dict:
    """Valide une définition de tactique ; ValueError avec un message lisible sinon."""
    conds = raw.get("conditions") if isinstance(raw, dict) else None
    if not isinstance(conds, list) or not conds:
        raise ValueError("Au moins une condition est requise")
    out = []
    for c in conds[:12]:
        if not isinstance(c, dict) or c.get("kind") not in CONDITION_KINDS:
            raise ValueError("Type de condition inconnu")
        k = c["kind"]
        d: dict = {"kind": k}
        if k in ("players_in_zone", "utility_in_zone"):
            poly = c.get("zone")
            if not isinstance(poly, list) or len(poly) < 3 or not all(isinstance(p, list) and len(p) == 2 for p in poly):
                raise ValueError("Zone : un polygone d'au moins 3 points")
            d["zone"] = [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in poly[:40]]
            d["from_s"] = max(0.0, float(c.get("from_s", 0) or 0))
            d["to_s"] = min(float(ROUND_S), float(c.get("to_s", ROUND_S) or ROUND_S))
            if d["to_s"] <= d["from_s"]:
                raise ValueError("Fenêtre de temps invalide")
            if c.get("level"):
                d["level"] = str(c["level"])[:16]
        if k == "players_in_zone":
            d["min_players"] = int(min(5, max(1, int(c.get("min_players", 1) or 1))))
            if isinstance(c.get("players"), list) and c["players"]:
                d["players"] = [str(x)[:20] for x in c["players"][:5]]
        if k == "utility_in_zone":
            types = [t for t in (c.get("types") or []) if t in GRENADE_TYPES] or list(GRENADE_TYPES)
            d["types"] = types
            d["min_count"] = int(min(10, max(1, int(c.get("min_count", 1) or 1))))
            d["position"] = "throw" if c.get("position") == "throw" else "land"
        if k == "bomb_planted":
            site = c.get("site")
            d["site"] = site if site in ("A", "B") else None
            d["before_s"] = float(c.get("before_s", ROUND_S) or ROUND_S)
        if k in ("contact_before", "no_contact_before"):
            d["s"] = max(0.0, float(c.get("s", 30) or 30))
        out.append(d)
    return {"conditions": out}


@dataclass
class RoundCtx:
    """Tout ce qu'il faut pour évaluer les tactiques d'un round : trames de nos joueurs, grenades, pose, contact."""
    rate: int
    t0: int
    end_tick: int
    ticks: np.ndarray
    X: np.ndarray            # (n, k) positions de nos joueurs
    Y: np.ndarray
    Z: np.ndarray
    alive: np.ndarray        # (n, k)
    levels: list[str]
    players: list[str] = field(default_factory=list)  # steamid de chaque colonne
    grenades: list[tuple[str, float, float, float, float, float, float]] = field(default_factory=list)  # type, throw_s, tx, ty, land_s, lx, ly
    plant_s: float | None = None
    plant_site: str | None = None
    contact_s: float | None = None
    meta: MapMeta | None = None

    def sec(self, tick: int) -> float:
        return (tick - self.t0) / self.rate


def _level_ok(cond: dict, meta: MapMeta | None, z: np.ndarray) -> np.ndarray:
    lvl = cond.get("level")
    if not lvl or meta is None or len(meta.levels) < 2:
        return np.ones(z.shape, dtype=bool)
    L = next((x for x in meta.levels if x.name == lvl), None)
    return np.ones(z.shape, dtype=bool) if L is None else (z >= L.z_min) & (z < L.z_max)


def evaluate(definition: dict, ctx: RoundCtx) -> float | None:
    """Instant (s) où la tactique est utilisée dans ce round, ou None."""
    at = 0.0
    for c in definition.get("conditions", []):
        k = c["kind"]
        t: float | None = None
        if k == "players_in_zone":
            lo = int(np.searchsorted(ctx.ticks, ctx.t0 + c.get("from_s", 0) * ctx.rate))
            hi = int(np.searchsorted(ctx.ticks, ctx.t0 + c.get("to_s", ROUND_S) * ctx.rate, side="right"))
            if hi > lo and ctx.X.shape[1]:
                inside = _inside(c["zone"], ctx.X[lo:hi], ctx.Y[lo:hi]) & ctx.alive[lo:hi] & _level_ok(c, ctx.meta, ctx.Z[lo:hi])
                who = c.get("players")
                if who and ctx.players:  # seulement les joueurs choisis
                    mask = np.array([sid in who for sid in ctx.players])
                    inside = inside & mask[None, :]
                counts = inside.sum(axis=1)
                hit = np.nonzero(counts >= c.get("min_players", 1))[0]
                if hit.size:
                    t = ctx.sec(int(ctx.ticks[lo + int(hit[0])]))
        elif k == "utility_in_zone":
            times = []
            for g in ctx.grenades:
                typ, throw_s, tx, ty, land_s, lx, ly = g
                if typ not in c.get("types", GRENADE_TYPES):
                    continue
                s_, px, py = (throw_s, tx, ty) if c.get("position") == "throw" else (land_s, lx, ly)
                if c.get("from_s", 0) <= s_ <= c.get("to_s", ROUND_S) and _point_in_poly(px, py, c["zone"]):
                    times.append(s_)
            times.sort()
            need = c.get("min_count", 1)
            if len(times) >= need:
                t = times[need - 1]
        elif k == "bomb_planted":
            if ctx.plant_s is not None and ctx.plant_s <= c.get("before_s", ROUND_S) and (not c.get("site") or ctx.plant_site == c["site"]):
                t = ctx.plant_s
        elif k == "contact_before":
            if ctx.contact_s is not None and ctx.contact_s <= c.get("s", 30):
                t = ctx.contact_s
        elif k == "no_contact_before":
            if ctx.contact_s is None or ctx.contact_s > c.get("s", 30):
                t = c.get("s", 30)
        if t is None:
            return None
        at = max(at, t)
    return round(at, 1)


def _round_ctx(session: Session, meta: MapMeta, m: Match, r: Round, team_id: int, side: str) -> RoundCtx | None:
    fr = session.get(RoundFrames, r.id)
    if fr is None:
        return None
    fd = decode_fields(fr.blob, ("x", "y", "z", "flags"))
    team_of = {mp.steamid: mp.team_id for mp in m.players}
    cols = [j for j, sid in enumerate(fd.players) if team_of.get(sid) == team_id]
    rate = m.demo_tickrate or 64
    t0 = r.freeze_end_tick
    ctx = RoundCtx(rate=rate, t0=t0, end_tick=r.end_tick, ticks=fd.ticks, X=fd.fields["x"][:, cols], Y=fd.fields["y"][:, cols],
                   Z=fd.fields["z"][:, cols], alive=(fd.fields["flags"][:, cols] & FLAG_ALIVE) > 0, levels=[l.name for l in meta.levels], meta=meta,
                   players=[fd.players[j] for j in cols])
    for g in session.scalars(select(Grenade).where(Grenade.round_id == r.id)):
        if team_of.get(g.thrower) != team_id:
            continue
        land_tick = g.detonate_tick if g.detonate_tick is not None else g.throw_tick
        lx, ly = (g.detonate_x, g.detonate_y) if g.detonate_x is not None else (g.throw_x, g.throw_y)
        ctx.grenades.append((g.type, ctx.sec(g.throw_tick), g.throw_x, g.throw_y, ctx.sec(land_tick), float(lx), float(ly)))
    plant = session.scalar(select(BombEvent).where(BombEvent.round_id == r.id, BombEvent.type == "plant").order_by(BombEvent.tick).limit(1))
    if plant is not None:
        ctx.plant_s, ctx.plant_site = ctx.sec(plant.tick), plant.site if plant.site in ("A", "B") else None
    contact = session.scalar(select(Damage.tick).where(Damage.round_id == r.id, Damage.tick >= t0, Damage.attacker_side.is_not(None),
                                                      Damage.attacker_side != Damage.victim_side).order_by(Damage.tick).limit(1))
    if contact is not None:
        ctx.contact_s = ctx.sec(contact)
    return ctx


def tactic_dict(t: Tactic) -> dict:
    return {"id": t.id, "name": t.name, "map": t.map_name, "side": t.side, "category": t.category,
            "category_label": CATEGORY_LABELS.get(t.category, t.category), "tags": json.loads(t.tags or "[]"),
            "description": t.description, "definition": json.loads(t.definition or "{}"), "builtin": False,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None}


def detect_playbook(session: Session, maps: dict[str, MapMeta], team_id: int, map_name: str, side: str,
                    match_ids: set[int] | None) -> dict:
    """Rounds de l'équipe (carte, camp, sélection) avec leur séquence de tactiques, agrégats par catégorie et par tranche,
    tempo et sites."""
    meta = maps[map_name]
    tactics = [t for t in session.scalars(select(Tactic).where(Tactic.map_name == map_name, Tactic.side == side).order_by(Tactic.id))]
    defs = {t.id: json.loads(t.definition or "{}") for t in tactics}
    auto = team_playbook(session, maps, team_id, map_name) if side == "T" else None
    auto_by_round = {x["round_id"]: x for x in (auto["t"]["list"] if auto else [])}
    q = select(Match).where(Match.map_name == map_name, (Match.team_a_id == team_id) | (Match.team_b_id == team_id)).order_by(Match.id)
    rounds_out = []
    for m in session.scalars(q):
        if match_ids is not None and m.id not in match_ids:
            continue
        opp = m.team_b.name if m.team_a_id == team_id else m.team_a.name
        date = match_date(m)
        for r in session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)):
            our_side = "T" if r.t_team_id == team_id else "CT"
            if our_side != side:
                continue
            ctx = _round_ctx(session, meta, m, r, team_id, side)
            if ctx is None:
                continue
            seq = []
            for t in tactics:
                at = evaluate(defs[t.id], ctx)
                if at is not None:
                    seq.append({"tactic": t.id, "name": t.name, "category": t.category, "at_s": at})
            a = auto_by_round.get(r.id)
            if a:
                key = f"auto:{a['category']}"
                b = BUILTIN.get(key)
                if b:
                    at = a["contact_s"] if a["category"] == "rush" else (a["plant_s"] or a["contact_s"]) if a["category"] in ("execute", "split", "fake") else 0.0
                    seq.append({"tactic": key, "name": b["name"], "category": b["category"], "at_s": round(float(at or 0.0), 1)})
            seq.sort(key=lambda x: x["at_s"])
            own_buy, opp_buy = (r.t_buy_type, r.ct_buy_type) if side == "T" else (r.ct_buy_type, r.t_buy_type)
            rounds_out.append({"round_id": r.id, "match_id": m.id, "number": r.number, "won": r.winner_side == side, "buy": own_buy,
                               "opp_buy": opp_buy, "opponent": opp, "date": date.isoformat() if date else None, "sequence": seq,
                               "site": (a or {}).get("site"), "plant_s": (a or {}).get("plant_s"), "contact_s": ctx.contact_s if ctx.contact_s is None else round(ctx.contact_s, 1),
                               # fin du default et prise du site, recopiées du playbook automatique
                               "default_kind": (a or {}).get("default_kind"), "engage_s": (a or {}).get("engage_s"),
                               "engage_site": (a or {}).get("engage_site")})
    n = len(rounds_out) or 1
    catalog: dict[str, dict] = {str(t.id): tactic_dict(t) for t in tactics}
    for k, b in BUILTIN.items():
        if b["side"] == side:
            catalog[k] = {"id": k, "name": b["name"], "map": map_name, "side": side, "category": b["category"],
                          "category_label": CATEGORY_LABELS.get(b["category"], b["category"]), "tags": [], "description": "", "definition": {}, "builtin": True}
    # usage par tactique, avec les rounds, et par tranche de temps
    usage: dict[str, dict] = {k: {"used": 0, "won": 0, "rounds": [], "buckets": {b[0]: 0 for b in TIME_BUCKETS}} for k in catalog}
    for ro in rounds_out:
        for s in ro["sequence"]:
            u = usage[str(s["tactic"])]
            u["used"] += 1
            u["won"] += ro["won"]
            u["rounds"].append(ro["round_id"])
            for label, a, b in TIME_BUCKETS:
                if a <= s["at_s"] < b:
                    u["buckets"][label] += 1
                    break
    categories = []
    for key, label in CATEGORIES:
        items = [{**catalog[k], **usage[k], "pct": round(100 * usage[k]["used"] / n), "win_pct": round(100 * usage[k]["won"] / usage[k]["used"]) if usage[k]["used"] else 0}
                 for k in catalog if catalog[k]["category"] == key]
        if items:
            items.sort(key=lambda x: (-x["used"], x["name"]))
            categories.append({"key": key, "label": label, "tactics": items})
    other = [k for k in catalog if catalog[k]["category"] not in CATEGORY_LABELS]
    if other:
        categories.append({"key": "other", "label": "Autres", "tactics": [{**catalog[k], **usage[k], "pct": round(100 * usage[k]["used"] / n), "win_pct": 0} for k in other]})
    return {"map": map_name, "team_id": team_id, "side": side, "rounds": rounds_out, "total": len(rounds_out), "categories": categories,
            "buckets": [b[0] for b in TIME_BUCKETS], "tempo": _tempo(rounds_out), "sites": _sites(rounds_out)}


def _tempo(rounds: list[dict]) -> dict:
    rows = [r for r in rounds if r["buy"] not in ("eco", "semi")]
    n = len(rows) or 1
    at = lambda r: r["plant_s"] if r["plant_s"] is not None else r["contact_s"]  # noqa: E731
    return {"rounds": len(rows), "buckets": [{"label": l, "n": sum(1 for r in rows if at(r) is not None and a <= at(r) < b)} for l, a, b in TIME_BUCKETS],
            "never": sum(1 for r in rows if at(r) is None), "total": n}


def _sites(rounds: list[dict]) -> dict:
    rows = [r for r in rounds if r["buy"] not in ("eco", "semi")]
    return {"rounds": len(rows), "A": sum(1 for r in rows if r.get("site") == "A"), "B": sum(1 for r in rows if r.get("site") == "B"),
            "none": sum(1 for r in rows if not r.get("site"))}


def _alive_at(ctx: RoundCtx, at_s: float) -> int:
    i = int(np.searchsorted(ctx.ticks, ctx.t0 + at_s * ctx.rate))
    i = min(max(0, i), len(ctx.ticks) - 1)
    return int(ctx.alive[i].sum()) if ctx.alive.size else 0


def find_patterns(session: Session, maps: dict[str, MapMeta], team_id: int, map_name: str, side: str, match_ids: set[int] | None,
                  definition: dict, filters: dict | None = None) -> dict:
    """Pattern Finder : rounds de l'équipe (carte, camp, sélection) où le motif (conditions, comme une tactique non
    enregistrée) est vrai, avec les filtres de round : `buy` (liste), `outcome` (won / lost), `min_alive` (vivants à
    l'instant du motif), `max_gap_s` (écart maximal entre la première et la dernière condition), `include_tactics` /
    `exclude_tactics` (ids de tactiques), `negate` (rounds qui ne correspondent pas)."""
    f = filters or {}
    meta = maps[map_name]
    conds = definition.get("conditions", []) if definition else []
    needed = {int(x) for x in (f.get("include_tactics") or [])} | {int(x) for x in (f.get("exclude_tactics") or [])}
    tdefs = {t.id: json.loads(t.definition or "{}") for t in session.scalars(select(Tactic).where(Tactic.id.in_(needed)))} if needed else {}
    q = select(Match).where(Match.map_name == map_name, (Match.team_a_id == team_id) | (Match.team_b_id == team_id)).order_by(Match.id)
    total, matched = 0, []
    for m in session.scalars(q):
        if match_ids is not None and m.id not in match_ids:
            continue
        opp = m.team_b.name if m.team_a_id == team_id else m.team_a.name
        date = match_date(m)
        for r in session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)):
            our_side = "T" if r.t_team_id == team_id else "CT"
            if our_side != side:
                continue
            own_buy, opp_buy = (r.t_buy_type, r.ct_buy_type) if side == "T" else (r.ct_buy_type, r.t_buy_type)
            won = r.winner_side == side
            if f.get("buy") and own_buy not in f["buy"]:
                continue
            if (f.get("outcome") == "won" and not won) or (f.get("outcome") == "lost" and won):
                continue
            ctx = _round_ctx(session, meta, m, r, team_id, side)
            if ctx is None:
                continue
            total += 1
            ok, at = True, 0.0
            if conds:
                times = []
                for c in conds:
                    t = evaluate({"conditions": [c]}, ctx)
                    if t is None:
                        ok = False
                        break
                    times.append(t)
                if ok:
                    at = max(times)
                    if f.get("max_gap_s") is not None and max(times) - min(times) > float(f["max_gap_s"]):
                        ok = False
            if ok and f.get("min_alive") and _alive_at(ctx, at) < int(f["min_alive"]):
                ok = False
            if ok and f.get("include_tactics"):
                ok = all(evaluate(tdefs.get(int(t), {}), ctx) is not None for t in f["include_tactics"])
            if ok and f.get("exclude_tactics"):
                ok = not any(evaluate(tdefs.get(int(t), {}), ctx) is not None for t in f["exclude_tactics"])
            if f.get("negate"):
                ok = not ok
            if ok:
                matched.append({"round_id": r.id, "match_id": m.id, "number": r.number, "won": won, "buy": own_buy, "opp_buy": opp_buy,
                                "opponent": opp, "date": date.isoformat() if date else None, "at_s": at})
    return {"total": total, "matched": matched, "ids": [x["round_id"] for x in matched]}
