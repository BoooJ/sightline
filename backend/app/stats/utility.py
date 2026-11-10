# backend/app/stats/utility.py
"""Utilitaire gâché : grenades encore en poche à la dernière image vivante d'un joueur, en trois montants (mort,
vivant, perdu en fin de mi-temps), et deux événements (smoke gardée par le lurk, ancre seule morte avec sa molotov).

L'inventaire des images liste chaque type de grenade une seule fois : deux flashs achetées n'y apparaissent qu'une
fois. Les flashs sont donc corrigées par un registre (gardées du round précédent + achetées − lancées, deux au plus)."""
from __future__ import annotations

import math
from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.storage.models import BombEvent, Match, Round

NADES = {"Smoke Grenade": 300, "Flashbang": 200, "High Explosive Grenade": 300, "Molotov": 400,
         "Incendiary Grenade": 500, "Decoy Grenade": 50}
FLASH, SMOKE = "Flashbang", "Smoke Grenade"
FIRE = ("Molotov", "Incendiary Grenade")
HALF_END = (12, 24)             # derniers rounds d'une mi-temps (le dernier du match s'ajoute)
LURK_D = 900.0                  # distance moyenne au coéquipier vivant le plus proche entre 15 et 45 s
ANCHOR_SITE_D, ANCHOR_MATE_D = 900.0, 800.0


def leftover_nades(inv: list[str], carried_flash: int, bought_flash: int, thrown_flash: int) -> list[str]:
    """Grenades restantes (noms du jeu, une entrée par grenade). `inv` : inventaire à la dernière image vivante."""
    out = [n for n in dict.fromkeys(inv) if n in NADES and n != FLASH]
    # le registre ne sert qu'à départager une ou deux flashs quand l'inventaire en montre une : sans flash visible, le
    # joueur n'en a plus (les achats sont parfois journalisés plus de deux fois : revente, rachat après un drop)
    flashes = max(1, min(2, carried_flash + bought_flash - thrown_flash)) if FLASH in inv else 0
    return out + [FLASH] * flashes


def is_half_end(number: int, last_number: int) -> bool:
    return number in HALF_END or number == last_number


def _value(items: list[str]) -> int:
    return sum(NADES[n] for n in items)


def round_utility(number: int, last_number: int, tickrate: int, freeze_end_tick: int, plant_tick: int | None,
                  sites: dict[str, tuple], players: dict[str, dict]) -> dict:
    """Utilitaire d'un round. `players[steamid]` : side, alive (vivant à la fin), inv (noms d'armes à la dernière image
    vivante), carried_flash / bought_flash / thrown_flash, et selon le cas : mate_d (distance moyenne au coéquipier
    vivant le plus proche, 15–45 s), alive_40, inv_40, tick_40 (smoke du lurk) ; death_tick, death_pos, ct_d (CT vivant
    le plus proche à la mort, None s'il n'y en a pas) (ancre seule).
    Retourne {"players": {sid: {dead_value, alive_value, half_end_value}}, "events": [{round, kind, steamid, tick}]}."""
    half_end = is_half_end(number, last_number)
    out, events = {}, []
    for sid, p in players.items():
        value = _value(leftover_nades(p.get("inv") or [], p.get("carried_flash", 0), p.get("bought_flash", 0), p.get("thrown_flash", 0)))
        out[sid] = {"dead_value": 0 if p.get("alive") else value,
                    "alive_value": value if p.get("alive") and not half_end else 0,
                    "half_end_value": value if p.get("alive") and half_end else 0}
        if p.get("side") == "T" and p.get("alive_40") and (p.get("mate_d") or 0) > LURK_D and SMOKE in (p.get("inv_40") or []):
            events.append({"round": number, "kind": "lurk_smoke", "steamid": sid, "tick": int(p.get("tick_40") or 0)})
        dt = p.get("death_tick")
        if p.get("side") == "CT" and dt is not None and (plant_tick is None or dt < plant_tick) and p.get("death_pos") \
                and any(n in FIRE for n in p.get("inv") or []) and (p.get("ct_d") is None or p["ct_d"] >= ANCHOR_MATE_D):
            x, y = p["death_pos"][:2]
            if any(math.hypot(x - c[0], y - c[1]) <= ANCHOR_SITE_D for c in sites.values()):
                events.append({"round": number, "kind": "lone_anchor_molotov", "steamid": sid, "tick": int(dt)})
    return {"players": out, "events": events}


def library_sites(session: Session, map_name: str) -> dict[str, tuple]:
    """Centre (x, y, z) de chaque site : moyenne des poses réelles de la bibliothèque sur cette carte."""
    pts: dict[str, list] = defaultdict(list)
    q = (select(BombEvent).join(Round, Round.id == BombEvent.round_id).join(Match, Match.id == Round.match_id)
         .where(Match.map_name == map_name, BombEvent.type == "plant", BombEvent.x.is_not(None)))
    for b in session.scalars(q):
        if b.site in ("A", "B"):
            pts[b.site].append((b.x, b.y, b.z))
    return {k: tuple(sum(c) / len(v) for c in zip(*v)) for k, v in pts.items()}
