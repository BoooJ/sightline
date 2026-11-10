"""Modèle normalisé d'une démo, indépendant de demoparser2.

Produit par app.parsing.build.build_demo(RawDemo) et consommé par le stockage.
Les steamid sont des chaînes ; les côtés sont "CT" ou "T".
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

Vec3 = tuple[float, float, float]


@dataclass
class PTeam:
    key: str  # identifiant stable dans la démo : "A" (CT au round 1) ou "B"
    name: str


@dataclass
class PPlayer:
    steamid: str
    name: str
    team_key: str
    starting_side: str


@dataclass
class PRound:
    number: int
    start_tick: int
    freeze_end_tick: int
    end_tick: int
    winner_side: str | None
    end_reason: str | None
    ct_team_key: str
    t_team_key: str
    score_ct_before: int
    score_t_before: int
    ct_equip_value: int
    t_equip_value: int
    ct_buy_type: str
    t_buy_type: str


@dataclass
class PKill:
    round_number: int
    tick: int
    attacker: str | None
    victim: str
    assister: str | None
    flash_assist: bool
    weapon: str
    headshot: bool
    penetrated: int
    through_smoke: bool
    noscope: bool
    attacker_blind: bool
    attacker_pos: Vec3 | None
    victim_pos: Vec3
    is_opening: bool = False
    is_trade: bool = False
    traded_player: str | None = None  # coéquipier vengé par ce kill
    attacker_side: str | None = None
    victim_side: str | None = None
    attacker_place: str | None = None  # callout (last_place_name)
    victim_place: str | None = None


@dataclass
class PDamage:
    round_number: int
    tick: int
    attacker: str | None
    victim: str
    weapon: str
    dmg_health: int
    dmg_armor: int
    hitgroup: str
    dmg_health_real: int = 0
    attacker_side: str | None = None
    victim_side: str | None = None


@dataclass
class PShot:
    round_number: int
    tick: int
    shooter: str
    weapon: str
    pos: Vec3
    yaw: float
    pitch: float
    speed: float | None = None  # vitesse horizontale au tir (u/s)


@dataclass
class PGrenade:
    round_number: int
    entity_id: int
    type: str  # smoke | flash | he | molotov | incendiary | decoy
    thrower: str
    throw_tick: int
    throw_pos: Vec3
    throw_yaw: float | None
    throw_pitch: float | None
    trajectory: list[tuple[int, float, float, float]]
    detonate_tick: int | None
    detonate_pos: Vec3 | None
    end_tick: int | None


@dataclass
class PBombEvent:
    round_number: int
    tick: int
    type: str  # pickup | drop | plant | defuse | explode
    player: str | None
    site: str | None  # "A" | "B" | None
    pos: Vec3 | None


@dataclass
class PPurchase:
    round_number: int
    tick: int
    player: str
    item: str
    cost: int


@dataclass
class PBlind:
    round_number: int
    tick: int
    attacker: str | None
    victim: str
    duration: float


@dataclass
class PRoundFrames:
    """Positions/états échantillonnés d'un round. Chaque champ : tableau (n_ticks, n_players)."""

    round_number: int
    ticks: np.ndarray  # int32 (n_ticks,)
    players: list[str]  # steamids, ordre des colonnes
    fields: dict[str, np.ndarray]
    weapons: list[str]  # table de chaînes pour le champ "weapon"
    inventory: list[list[list[int]]]  # [tick][player] -> indices dans `weapons`
    # code de partage du réticule de chaque joueur (ordre de `players`), None si inconnu ; [] avant PARSER_VERSION 3
    xhair: list[str | None] = field(default_factory=list)
    # réglages des bras de chaque joueur (ordre de `players`) : [viewmodel_fov, offset x, y, z], None si inconnus ;
    # [] avant PARSER_VERSION 3
    vm: list[list[float] | None] = field(default_factory=list)
    # tirs d'armes à feu du round avec le recul de la caméra du tireur (view punch) juste après le tir :
    # [tick, indice du joueur dans `players`, vertical, horizontal] en degrés, par ordre de tick, suivis du recul de
    # visée au tir [vertical, horizontal] s'il a été lu (démos CS2 récentes : 6 valeurs) ; [] si inconnus
    # (replay d'avant la tâche 1.10, démo sans la prop). Le champ `fields` peut aussi porter « yawm » / « pitchm » : lacet et
    # angle vertical au tick situé entre l'image i et l'image i+1 (dernière image : sa propre valeur).
    punch: list[list[int | float]] = field(default_factory=list)
    # agent équipé par chaque joueur (ordre de `players`) : nom du modèle de CS2 (« tm_leet_variantf »), None pour l'agent
    # par défaut du camp ou s'il est inconnu ; [] dans un replay analysé avant la lecture de l'agent
    agents: list[str | None] = field(default_factory=list)
    # force de la mort de chaque victime du round (ragdoll du replay 3D) : [tick, indice du joueur dans `players`, fx, fy,
    # fz] en unités du jeu, arrondies au dixième, par ordre de tick ; [] dans un replay analysé avant la lecture de la force
    # (le navigateur l'estime alors d'après l'arme, la zone touchée et le tireur)
    forces: list[list[int | float]] = field(default_factory=list)


# Bits du champ "flags"
FLAG_ALIVE = 1
FLAG_HELMET = 2
FLAG_DEFUSER = 4
FLAG_BOMB = 8
FLAG_DEFUSING = 16
FLAG_SCOPED = 32
FLAG_AIRBORNE = 64  # en l'air ; 0 (au sol) dans un replay analysé avant PARSER_VERSION 3
FLAG_LADDER = 128  # sur une échelle (m_MoveType = 9) : le plus souvent aussi « en l'air » ; absent d'un replay plus ancien

# Bits du champ "keys" (PARSER_VERSION 3) : touches tenues et déplacement, mêmes valeurs que KEYS dans
# frontend/src/features/replay/engine/state.ts
KEY_FORWARD = 1
KEY_BACK = 2
KEY_LEFT = 4
KEY_RIGHT = 8
KEY_JUMP = 16
KEY_WALK = 32  # is_walking (marche, Maj)
KEY_FIRE = 64
KEY_RIGHTCLICK = 128
KEY_RELOAD = 256
KEY_USE = 512
KEY_INSPECT = 1024
KEY_DUCK = 2048  # ducking (accroupi ou en train de s'accroupir)

NO_AMMO = 65535  # champs "clip" (balles) et "reserve" (chargeurs de rechange) : inconnus (pas d'arme à feu en main, démo sans la colonne)


@dataclass
class ParsedDemo:
    map_name: str
    server_name: str
    tickrate: int
    sample_rate: int
    parser_version: str
    teams: list[PTeam]
    players: list[PPlayer]
    rounds: list[PRound]
    score: dict[str, int]  # team_key -> rounds gagnés
    kills: list[PKill] = field(default_factory=list)
    damages: list[PDamage] = field(default_factory=list)
    shots: list[PShot] = field(default_factory=list)
    grenades: list[PGrenade] = field(default_factory=list)
    bomb_events: list[PBombEvent] = field(default_factory=list)
    purchases: list[PPurchase] = field(default_factory=list)
    blinds: list[PBlind] = field(default_factory=list)
    frames: dict[int, PRoundFrames] = field(default_factory=dict)
