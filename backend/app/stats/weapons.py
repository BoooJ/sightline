# backend/app/stats/weapons.py
"""Arme principale d'un joueur sur un round (l'arme tenue le plus souvent, les fusils avant les pistolets), classes et
prix d'achat (pour le rating économique : valeur des armes des adversaires tués ÷ valeur de sa propre arme)."""
from __future__ import annotations

from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.parsing.model import FLAG_ALIVE
from app.storage.frames_codec import decode_fields
from app.storage.models import Match, Round, RoundFrames

WEAPON_CLASS = {
    "ak47": "rifle", "m4a1": "rifle", "m4a1_silencer": "rifle", "m4a4": "rifle", "aug": "rifle", "sg556": "rifle",
    "famas": "rifle", "galilar": "rifle",
    "awp": "sniper", "ssg08": "sniper", "scar20": "sniper", "g3sg1": "sniper",
    "mac10": "smg", "mp9": "smg", "mp7": "smg", "mp5sd": "smg", "ump45": "smg", "p90": "smg", "bizon": "smg",
    "nova": "heavy", "xm1014": "heavy", "mag7": "heavy", "sawedoff": "heavy", "m249": "heavy", "negev": "heavy",
    "glock": "default_pistol", "usp_silencer": "default_pistol", "hkp2000": "default_pistol",
    "p250": "pistol", "fiveseven": "pistol", "tec9": "pistol", "cz75a": "pistol", "deagle": "pistol", "revolver": "pistol",
    "elite": "pistol",
}
CLASS_LABELS = {"rifle": "Rifle", "sniper": "Sniper", "smg": "SMG", "heavy": "Lourde", "pistol": "Pistolet", "default_pistol": "Pistolet de base"}
WEAPON_PRICE = {
    "ak47": 2700, "m4a1": 3100, "m4a1_silencer": 2900, "m4a4": 3100, "aug": 3300, "sg556": 3000, "famas": 2050, "galilar": 1800,
    "awp": 4750, "ssg08": 1700, "scar20": 5000, "g3sg1": 5000,
    "mac10": 1050, "mp9": 1250, "mp7": 1500, "mp5sd": 1500, "ump45": 1200, "p90": 2350, "bizon": 1400,
    "nova": 1050, "xm1014": 2000, "mag7": 1300, "sawedoff": 1100, "m249": 5200, "negev": 1700,
    "glock": 200, "usp_silencer": 200, "hkp2000": 200, "p250": 300, "fiveseven": 500, "tec9": 500, "cz75a": 500,
    "deagle": 700, "revolver": 600, "elite": 300,
}
_PRIORITY = {"rifle": 0, "sniper": 0, "smg": 1, "heavy": 1, "pistol": 2, "default_pistol": 3}


def norm_weapon(w: str) -> str:
    w = (w or "").lower().removeprefix("weapon_")
    return {"m4a1-s": "m4a1_silencer", "usp-s": "usp_silencer", "ak-47": "ak47"}.get(w, w)


def primary_weapon(held: Counter) -> str | None:
    """Parmi les armes tenues (nom → échantillons), la plus tenue de la meilleure classe (fusils d'abord)."""
    guns = [(w, n) for w, n in held.items() if norm_weapon(w) in WEAPON_CLASS]
    if not guns:
        return None
    best = min(_PRIORITY[WEAPON_CLASS[norm_weapon(w)]] for w, _ in guns)
    return norm_weapon(max((g for g in guns if _PRIORITY[WEAPON_CLASS[norm_weapon(g[0])]] == best), key=lambda g: g[1])[0])


def round_primary_weapons(session: Session, m: Match) -> dict[tuple[int, str], str | None]:
    """{(round_id, steamid): arme principale} pour chaque round du match (d'après les trames)."""
    out: dict[tuple[int, str], str | None] = {}
    for r in session.scalars(select(Round).where(Round.match_id == m.id)):
        fr = session.get(RoundFrames, r.id)
        if fr is None:
            continue
        fd = decode_fields(fr.blob, ("flags", "weapon"))
        if "weapon" not in fd.fields or not fd.weapons:
            continue
        alive = (fd.fields["flags"] & FLAG_ALIVE) > 0
        W = fd.fields["weapon"]
        for j, sid in enumerate(fd.players):
            sel = alive[:, j]
            held = Counter(fd.weapons[w] for w in W[sel, j].tolist() if 0 <= w < len(fd.weapons) and fd.weapons[w])
            out[(r.id, sid)] = primary_weapon(held)
    return out
