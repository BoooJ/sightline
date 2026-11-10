"""Seul module qui parle à demoparser2.

Produit un RawDemo : des DataFrames bruts, sérialisables en Parquet (fixtures de test).
Tout le reste de l'application consomme RawDemo via app.parsing.build, jamais demoparser2.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa

log = logging.getLogger(__name__)

EVENTS: list[str] = [
    "round_start", "round_end", "round_freeze_end", "round_officially_ended",
    "player_death", "player_hurt", "weapon_fire", "grenade_thrown",
    "bomb_planted", "bomb_defused", "bomb_exploded", "bomb_pickup", "bomb_dropped",
    "smokegrenade_detonate", "smokegrenade_expired", "flashbang_detonate", "hegrenade_detonate",
    "inferno_startburn", "inferno_expire", "decoy_started", "decoy_detonate",
    "player_spawn", "player_team",
]
# Événements sans props joueur additionnelles (format différent dans demoparser2)
PLAIN_EVENTS: list[str] = ["item_purchase"]

# vitesse : contre-strafe au tir ; lieu : callouts des kills
EVENT_PLAYER_PROPS = ["X", "Y", "Z", "yaw", "pitch", "team_num", "velocity_X", "velocity_Y", "last_place_name"]
EVENT_OTHER_PROPS = ["total_rounds_played", "is_warmup_period"]

# FOV de la caméra du joueur (90 hors lunette, 40/10/15/45 en lunette ; 0 = défaut du jeu, soit 90) et réglages de ses
# bras (viewmodel_fov, viewmodel_offset_x/y/z). Noms complets : le nom court `fov` de demoparser2 vaut toujours 0.
FOV_PROP = "CCSPlayerPawn.CCSPlayer_CameraServices.m_iFOV"
VIEWMODEL_PROPS: list[str] = ["CCSPlayerPawn.m_flViewmodelFOV", "CCSPlayerPawn.m_flViewmodelOffsetX",
                              "CCSPlayerPawn.m_flViewmodelOffsetY", "CCSPlayerPawn.m_flViewmodelOffsetZ"]
# Mode de déplacement du pawn (2 : marche, 9 : échelle). Nom complet : le nom court `m_MoveType` vaut toujours 5 (vérifié le
# 08/11/2026 sur astralis-vs-falcons-m1-nuke : 448 lignes sur échelle à 32 ticks d'écart, 98 % avec is_airborne vrai).
MOVETYPE_PROP = "CCSPlayerPawn.m_MoveType"
MOVETYPE_LADDER = 9
# Vue du joueur (PARSER_VERSION 3) : posture, en l'air, munitions, lunette, réticule, touches, FOV, bras. Une prop qu'une
# démo ne fournit pas ne produit pas de colonne (demoparser2 0.42.1, sans erreur) : build_frames prend alors une valeur
# par défaut.
VIEW_PROPS: list[str] = [
    "duck_amount", "ducking", "is_airborne", "is_walking", "active_weapon_ammo", "total_ammo_left", "zoom_lvl",
    "crosshair_code", "FORWARD", "BACK", "LEFT", "RIGHT", "JUMP", "FIRE", "RIGHTCLICK", "RELOAD", "USE", "INSPECT",
    FOV_PROP, *VIEWMODEL_PROPS,
    "agent_skin",  # agent équipé : « customplayer_<agent> » ; « customplayer_ct_map_based » / « …_t_… » : agent par défaut
    MOVETYPE_PROP,  # 9 : le joueur est sur une échelle
]
# Colonnes de raw.ticks (images échantillonnées) : exactement celles que build_frames lit, avec `tick` et `steamid`.
# Ni nom du joueur, ni clan, ni lieu, ni score, ni phase du round : des textes ou des entiers répétés sur 1,8 million de
# lignes (démo de 945 Mo) que personne ne relit (noms et clans viennent des instantanés).
TICK_PROPS: list[str] = [
    "X", "Y", "Z", "yaw", "pitch", "health", "armor_value", "has_helmet", "has_defuser",
    "is_alive", "team_num", "active_weapon_name", "balance", "flash_duration",
    "is_defusing", "is_scoped", "inventory", "current_equip_value",
    *VIEW_PROPS,
]
THROW_PROPS: list[str] = ["X", "Y", "Z", "yaw", "pitch"]
# Regard à chaque tick (64 Hz) : lacet et angle vertical lus aussi aux ticks situés ENTRE deux images (tick du milieu), en
# un appel à part qui ne demande que ces deux props (lignes légères : ~5 s pour 780 000 lignes, contre ~10 s pour 250 000
# lignes d'une passe des images).
ANGLE_PROPS: list[str] = ["yaw", "pitch"]
# Recul de la caméra (view punch) : [vertical, horizontal, roulis] en degrés, fixé à chaque tir puis constant jusqu'au tir
# suivant (m_nCsViewPunchAngleTick et ..TickRatio sont une horloge de 128 Hz sans rapport avec les ticks de la démo). Il
# faut le lire AU tick du tir : l'événement weapon_fire est émis avant la mise à jour de la prop (sa valeur est celle du tir
# précédent, vérifié le 31/10/2026 sur 250 tirs : égale à celle du tick t-1 dans 100 % des cas, et au tick t+1, t+2, t+3
# la valeur est celle du tick t).
PUNCH_PROP = "CCSPlayerPawn.CCSPlayer_CameraServices.m_vecCsViewPunchAngle"
# Recul de visée (aim punch) des démos CS2 récentes (CCSPlayer_AimPunchServices, qui remplace m_aimPunchAngle, absent de
# ces démos) : angle de base [vertical, horizontal, roulis] posé à chaque tir, lu au tick du tir dans le même appel que le
# recul de la caméra. C'est le recul de visée laissé par les tirs d'avant : 0 au 1er tir d'une rafale, puis il grandit ;
# la vue du joueur en tire l'intensité du recul des bras (vérifié le 01/11/2026 sur G2–Astralis, NertZ, 5 tirs d'AK de
# 16346 à 16372 : 0 ; −0,098 ; −0,624 ; −1,439 ; −2,305, les valeurs attendues ; au tick t−1, le 1er tir lirait l'angle
# laissé par une rafale plus ancienne).
AIM_PUNCH_PROP = "CCSPlayerPawn.CCSPlayer_AimPunchServices.m_predictableBaseAngle"
# Force de la mort (ragdoll du replay 3D) : vecteur [x, y, z] (unités du jeu) posé par le jeu sur le pawn de la victime,
# à lire AU tick de player_death (au tick − 1, c'est encore celle d'une vie précédente ; vérifié le 06/11/2026 sur deux
# démos : direction tireur → victime à 12° près, normes par arme : fusils 24 000, AWP 28 000, pistolets 20 000, tête × 1,3).
# m_nForceBone n'est pas lu : son numéro d'os change d'une démo à l'autre (la zone touchée vient des blessures).
FORCE_PROP = "CCSPlayerPawn.m_vecForce"
# Instantané léger pris à chaque freeze_end et round_end, sur tout le match :
# équipes, sides, score, économie. Sert à la normalisation sans dépendre des ticks échantillonnés.
SNAPSHOT_PROPS: list[str] = [
    "team_num", "team_clan_name", "team_rounds_total", "balance", "current_equip_value",
    "round_start_equip_value", "is_alive", "health", "total_rounds_played",
]
# Props demandées à parse_ticks : l'union de celles des groupes lus ensemble (images, instantanés, lancers, sonde)
PARSE_PROPS: list[str] = [*dict.fromkeys([*TICK_PROPS, *SNAPSHOT_PROPS, *THROW_PROPS, "game_time"])]
# Textes répétés sur chaque ligne de raw.ticks (arme en main, code de réticule) : gardés en catégories
CATEGORY_COLUMNS: tuple[str, ...] = ("active_weapon_name", "crosshair_code", "agent_skin")

PARSER_VERSION = "3"  # 2 : lieux des kills, vitesse des tirs ; 3 : vue du joueur (regard vertical, posture, touches…)

# Ticks lus par passe de parse_ticks (~250 000 lignes avec 10 joueurs). demoparser2 garde en mémoire toutes les valeurs
# d'une passe avant de rendre le tableau : une seule passe sur toute une démo à 32 images/s monte à ~3 Go. Chaque
# passe supplémentaire relit la démo (~4 s pour 677 Mo sur le PC de développement).
TICKS_PER_PASS = 25_000
# Ticks du milieu lus par appel : les lignes sont légères (tick, steamid, deux angles en float32), donc plus de ticks par
# passe que pour les images sans monter le pic mémoire.
ANGLE_TICKS_PER_PASS = 50_000


@dataclass
class RawDemo:
    header: dict
    tickrate: int
    sample_rate: int
    events: dict[str, pd.DataFrame] = field(default_factory=dict)
    ticks: pd.DataFrame = field(default_factory=pd.DataFrame)
    grenades: pd.DataFrame = field(default_factory=pd.DataFrame)
    throws: pd.DataFrame = field(default_factory=pd.DataFrame)
    snapshots: pd.DataFrame = field(default_factory=pd.DataFrame)
    # lacet et angle vertical aux ticks du milieu (tick, steamid, yaw, pitch) ; vide si aucun tick entre deux images
    angles: pd.DataFrame = field(default_factory=pd.DataFrame)
    # recul de la caméra du tireur à chaque weapon_fire (tick, steamid, punch_pitch, punch_yaw) et recul de visée
    # (aim_pitch, aim_yaw ; NaN si la démo ne l'a pas) ; vide si la démo n'a pas le recul de la caméra
    punch: pd.DataFrame = field(default_factory=pd.DataFrame)
    # force de la mort de chaque victime (tick, steamid, fx, fy, fz), lue au tick de player_death ; vide si la démo n'a ni
    # mort ni la prop, ou dans une extraction d'avant le ragdoll
    forces: pd.DataFrame = field(default_factory=pd.DataFrame)


def _safe_event(parser, name: str, with_props: bool) -> pd.DataFrame:
    try:
        if with_props:
            df = parser.parse_event(name, player=EVENT_PLAYER_PROPS, other=EVENT_OTHER_PROPS)
        else:
            df = parser.parse_event(name)
    except Exception:
        return pd.DataFrame()
    return df if isinstance(df, pd.DataFrame) else pd.DataFrame()


def _probe_ticks(last_tick: int) -> list[int]:
    return [max(1, last_tick // 2), max(2, last_tick // 2 + 640)]


def _tickrate_from(probe: pd.DataFrame) -> int:
    gt = probe.groupby("tick")["game_time"].first().sort_index()
    if len(gt) < 2 or gt.iloc[1] == gt.iloc[0]:
        return 64
    rate = (gt.index[1] - gt.index[0]) / (gt.iloc[1] - gt.iloc[0])
    return int(round(rate / 16) * 16) or 64


def _snapshot_ticks(events: dict[str, pd.DataFrame], tickrate: int, last_tick: int) -> list[int]:
    """Instantanés : début de round, fin du freeze, fin du temps d'achat (freeze_end + 20 s), fin de round."""
    snap = {int(t) for name in ("round_freeze_end", "round_end", "round_start")
            if not events[name].empty for t in events[name]["tick"].tolist() if t > 0}
    if not events["round_freeze_end"].empty:
        snap |= {int(t) + 20 * tickrate for t in events["round_freeze_end"]["tick"].tolist()}
    return sorted(t for t in snap if t <= last_tick)


def _pick(df: pd.DataFrame, ticks: list[int], props: list[str], names: bool = True) -> pd.DataFrame:
    """Lignes d'une lecture groupée pour ces ticks et ces props : identique à un parse_ticks(props, ticks) dédié
    (sauf la colonne `name`, absente si names=False)."""
    if not ticks:
        return pd.DataFrame()
    always = ("tick", "steamid", "name") if names else ("tick", "steamid")
    cols = [c for c in df.columns if c in props or c in always]
    return df.loc[df["tick"].isin(ticks), cols].reset_index(drop=True)


def _plain_bools(v: np.ndarray) -> np.ndarray | None:
    """Colonne `object` qui ne contient que True, False et None → tableau bool (None = faux, comme partout dans
    build_frames). Sinon None : la colonne reste telle quelle (un NaN ou un autre objet y a un sens propre)."""
    try:  # pyarrow refuse tout autre objet (NaN, entier, texte…), deux fois plus vite qu'un contrôle élément par élément
        return pa.array(v, type=pa.bool_()).fill_null(False).to_numpy(zero_copy_only=False)
    except pa.ArrowException:
        return None


def _exact_float32(v: np.ndarray) -> np.ndarray | None:
    """Le même tableau en float32 si aucune valeur n'y perd un bit (NaN compris), sinon None."""
    with np.errstate(over="ignore"):
        w = v.astype(np.float32)
    return w if np.array_equal(w, v, equal_nan=True) else None


def _compact(part: pd.DataFrame, books: dict[str, dict]) -> pd.DataFrame:
    """Même contenu en types plus petits (démo de 945 Mo : raw.ticks passe de 1,6 à 0,37 Go selon memory_usage(deep)) :
    - textes répétés (CATEGORY_COLUMNS) → codes entiers d'après le dictionnaire `books`, commun à toutes les passes
      (_categorical les remet en catégories après la concaténation) ;
    - booléens `object` (True / False / None : le joueur n'a pas de pawn) → bool ;
    - flottants exactement représentables en float32 → float32.
    build_frames lit ces colonnes en float64 (to_numpy), par _truthy, _on ou fillna(0) : mêmes valeurs qu'avant."""
    cols: dict[str, object] = {}
    for c in part.columns:
        s = part[c]
        packed = None
        if c in CATEGORY_COLUMNS:
            codes, uniques = pd.factorize(s)
            book = books.setdefault(c, {})
            remap = np.array([book.setdefault(u, len(book)) for u in uniques] + [-1], dtype=np.int32)  # -1 : manquant
            packed = remap[codes]
        elif s.dtype == object and c != "inventory":  # les inventaires sont déjà des tuples partagés (_shared_inventories)
            packed = _plain_bools(s.to_numpy())
        elif s.dtype == np.float64:
            packed = _exact_float32(s.to_numpy())
        cols[c] = s.copy() if packed is None else packed  # copie : une colonne qui garde la passe entière en vie coûte cher
    return pd.DataFrame(cols, copy=False)


def _categorical(full: pd.DataFrame, books: dict[str, dict]) -> pd.DataFrame:
    """Remet en catégories les colonnes de codes de _compact (une colonne absente d'une passe arrive ici avec des NaN)."""
    for c, book in books.items():
        if c in full.columns:
            codes = full[c].fillna(-1).to_numpy(np.int32)
            full[c] = pd.Categorical.from_codes(codes, categories=pd.Index(list(book)))
    return full


def _shared_inventories(col: pd.Series, cache: dict[tuple, tuple]) -> np.ndarray:
    """Inventaires en tuples partagés : des millions de listes de chaînes toutes neuves deviennent quelques milliers
    d'objets (~350 Mo de moins au pic sur une démo de 677 Mo à 32 i/s). build_frames les lit à l'identique. Une cellule
    qui n'est ni liste, ni tuple, ni tableau (None, NaN, pd.NA…) est un inventaire vide : (). Toutes les lignes passent
    ici, y compris celles que build_frames ignore (spectateurs, joueurs sans équipe)."""
    out = np.empty(len(col), dtype=object)
    for k, v in enumerate(col.tolist()):
        key = tuple(v.tolist() if isinstance(v, np.ndarray) else v) if isinstance(v, (list, tuple, np.ndarray)) else ()
        out[k] = cache.setdefault(key, key)
    return out


def _read_ticks(parser, groups: dict[str, tuple[list[int], list[str]]], progress,
                images: str = "ticks") -> dict[str, pd.DataFrame]:
    """parse_ticks par passes de TICKS_PER_PASS ticks, dans l'ordre des ticks. Chaque passe ne garde que les lignes et
    colonnes de chaque groupe (comme _pick), puis est libérée : même résultat qu'une seule passe sur tous les ticks.
    Le groupe `images` (raw.ticks, de loin le plus gros) est gardé sans `name` et en types compacts (_compact)."""
    wanted = sorted(set().union(*(t for t, _ in groups.values())))
    sets = {k: set(t) for k, (t, _) in groups.items()}
    parts: dict[str, list[pd.DataFrame]] = {k: [] for k in groups}
    cache: dict[tuple, tuple] = {}
    books: dict[str, dict] = {}
    for a in range(0, len(wanted), TICKS_PER_PASS):
        chunk = wanted[a:a + TICKS_PER_PASS]
        df = parser.parse_ticks(PARSE_PROPS, ticks=chunk)
        if "inventory" in df.columns:
            df["inventory"] = _shared_inventories(df["inventory"], cache)
        for k, (_, props) in groups.items():
            part = _pick(df, [t for t in chunk if t in sets[k]], props, names=k != images)
            parts[k].append(_compact(part, books) if k == images else part)
        del df
        progress(55 + 35 * min(a + TICKS_PER_PASS, len(wanted)) // len(wanted), "ticks")
    out = {}
    for k in list(parts):
        frames = parts.pop(k)  # les morceaux ne sont plus référencés que par `full` : libérés dès la concaténation
        full = [f for f in frames if len(f.columns)]  # sans les _pick vides (aucun tick du groupe dans la passe)
        del frames
        out[k] = pd.concat(full, ignore_index=True) if full else pd.DataFrame()
        del full
    out[images] = _categorical(out[images], books)
    return out


def frame_step(tickrate: int, sample_rate: int) -> int:
    """Ticks entre deux images : 2 pour 32 images/s sur une démo à 64 ticks, 4 pour 16 ; jamais moins de 1 (sample_rate ≥ tickrate).
    Seule définition du pas : la grille des images (extract_raw), les ticks du milieu et la vérification de build_frames
    en partent, pour ne pas se désaccorder."""
    return max(1, tickrate // sample_rate)


def mid_tick_offset(step: int) -> int:
    """Écart entre une image et le tick du milieu qui la suit : la moitié du pas, arrondie (1 pour 2 ticks entre images,
    2 pour 4) ; 0 s'il n'y a aucun tick entre deux images (une image par tick). Pour un pas impair (3), le tick est un peu avant
    le milieu alors que le moteur le place à mi-chemin (Replay / lerpMid) : sans effet à 32 images/s sur 64 ou 128 ticks."""
    return step // 2 if step >= 2 else 0


def _read_angles(parser, ticks: list[int]) -> pd.DataFrame:
    """Lacet et angle vertical de tous les joueurs à ces ticks (tick, steamid, yaw, pitch), lus par passes de
    ANGLE_TICKS_PER_PASS ticks. Les lignes sans steamid ou sans angle sont écartées ; pas de nom (texte répété)."""
    parts: list[pd.DataFrame] = []
    for a in range(0, len(ticks), ANGLE_TICKS_PER_PASS):
        df = parser.parse_ticks(ANGLE_PROPS, ticks=ticks[a:a + ANGLE_TICKS_PER_PASS])
        if not {"tick", "steamid", *ANGLE_PROPS} <= set(df.columns):
            return pd.DataFrame()
        part = df.loc[df["steamid"] != 0, ["tick", "steamid", *ANGLE_PROPS]].dropna(subset=ANGLE_PROPS)
        parts.append(part.astype({c: np.float32 for c in ANGLE_PROPS}).reset_index(drop=True))
        del df, part
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()


def _xy(col) -> list[tuple[float, float]]:
    """Deux premières composantes (vertical, horizontal) de chaque vecteur d'angles ; (NaN, NaN) si la valeur manque."""
    return [v[:2] if isinstance(v, (list, tuple, np.ndarray)) and len(v) >= 2 else (np.nan, np.nan) for v in col]


def _read_punch(parser, fires: pd.DataFrame) -> pd.DataFrame:
    """Recul de la caméra (tick, steamid, punch_pitch, punch_yaw) et recul de visée (aim_pitch, aim_yaw) du tireur à
    chaque tir, lus AU tick du tir (voir PUNCH_PROP et AIM_PUNCH_PROP). Un seul appel aux ticks des tirs, pour les deux
    props (quelques dizaines de milliers de lignes) ; seule la ligne du tireur est gardée. Recul de visée en NaN si la
    démo ne l'a pas ; vide si la démo n'a ni tir ni recul de la caméra. Si l'appel des deux props lève une exception (ou
    une panique Rust), nouvel essai avec le seul recul de la caméra, pour ce lot et les suivants : la prop de visée ne
    coûte jamais le recul de la caméra ; si ce nouvel essai échoue aussi, l'exception remonte (_optional)."""
    if fires.empty or not {"tick", "user_steamid"} <= set(fires.columns):
        return pd.DataFrame()
    shots = fires[["tick", "user_steamid"]].dropna().astype("int64").drop_duplicates()
    shots = shots.rename(columns={"user_steamid": "steamid"})
    parts: list[pd.DataFrame] = []
    ticks = sorted(shots["tick"].unique().tolist())
    props = [PUNCH_PROP, AIM_PUNCH_PROP]
    for a in range(0, len(ticks), TICKS_PER_PASS):
        chunk = ticks[a:a + TICKS_PER_PASS]
        try:
            df = parser.parse_ticks(props, ticks=chunk)
        except (KeyboardInterrupt, SystemExit, GeneratorExit):
            raise
        except BaseException:  # panique Rust comprise, comme _optional
            if props == [PUNCH_PROP]:
                raise
            props = [PUNCH_PROP]
            df = parser.parse_ticks(props, ticks=chunk)  # s'il échoue aussi : _optional prévient et rend un tableau vide
            log.warning("Recul de visée illisible : recul de la caméra seul pour les tirs", exc_info=True)
        if PUNCH_PROP not in df.columns:
            return pd.DataFrame()
        cols = ["tick", "steamid", PUNCH_PROP, *([AIM_PUNCH_PROP] if AIM_PUNCH_PROP in df.columns else [])]
        got = df[cols].astype({"tick": "int64", "steamid": "int64"})
        mine = got.merge(shots, on=["tick", "steamid"])  # le tireur seulement, pas les autres joueurs du tick
        vec = _xy(mine[PUNCH_PROP])
        aim = _xy(mine[AIM_PUNCH_PROP]) if AIM_PUNCH_PROP in mine.columns else [(np.nan, np.nan)] * len(mine)
        parts.append(pd.DataFrame({"tick": mine["tick"].to_numpy(), "steamid": mine["steamid"].to_numpy(),
                                   "punch_pitch": np.array([v[0] for v in vec], dtype=np.float32),
                                   "punch_yaw": np.array([v[1] for v in vec], dtype=np.float32),
                                   "aim_pitch": np.array([v[0] for v in aim], dtype=np.float32),
                                   "aim_yaw": np.array([v[1] for v in aim], dtype=np.float32)}))
        del df, got, mine
    if not parts:
        return pd.DataFrame()
    return pd.concat(parts, ignore_index=True).dropna(subset=["punch_pitch", "punch_yaw"]).reset_index(drop=True)


def _read_forces(parser, deaths: pd.DataFrame) -> pd.DataFrame:
    """Force de la mort de chaque victime (tick, steamid, fx, fy, fz en float32), lue AU tick de chaque player_death
    (FORCE_PROP), par lots de TICKS_PER_PASS ticks (quelques centaines de ticks par démo : un appel, 0,6 s mesuré) ;
    seule la ligne de la victime est gardée. Vide sans mort ou si la démo n'a pas la prop ; une exception remonte
    (_optional)."""
    if deaths.empty or not {"tick", "user_steamid"} <= set(deaths.columns):
        return pd.DataFrame()
    dead = deaths[["tick", "user_steamid"]].dropna().astype("int64").drop_duplicates()
    dead = dead.rename(columns={"user_steamid": "steamid"})
    ticks = sorted(dead["tick"].unique().tolist())
    parts: list[pd.DataFrame] = []
    for a in range(0, len(ticks), TICKS_PER_PASS):
        df = parser.parse_ticks([FORCE_PROP], ticks=ticks[a:a + TICKS_PER_PASS])
        if FORCE_PROP not in df.columns:
            return pd.DataFrame()
        got = df[["tick", "steamid", FORCE_PROP]].astype({"tick": "int64", "steamid": "int64"})
        mine = got.merge(dead, on=["tick", "steamid"])  # la victime seulement, pas les autres joueurs du tick
        vec = [v[:3] if isinstance(v, (list, tuple, np.ndarray)) and len(v) >= 3 else (np.nan, np.nan, np.nan)
               for v in mine[FORCE_PROP]]
        parts.append(pd.DataFrame({"tick": mine["tick"].to_numpy(), "steamid": mine["steamid"].to_numpy(),
                                   **{c: np.array([v[k] for v in vec], dtype=np.float32)
                                      for k, c in enumerate(("fx", "fy", "fz"))}}))
        del df, got, mine
    if not parts:
        return pd.DataFrame()
    return pd.concat(parts, ignore_index=True).dropna(subset=["fx", "fy", "fz"]).reset_index(drop=True)


def _optional(what: str, read, *args) -> pd.DataFrame:
    """Lecture facultative (enrichissement de la vue du joueur) : toute exception du parseur donne un tableau vide et un
    avertissement, comme _safe_event pour les événements. Une démo qui s'analyse aujourd'hui s'analyse toujours, avec
    seulement un peu moins de détail (images sans échantillon du milieu, ou sans recul au tir). Une panique Rust de
    demoparser2 (pyo3_runtime.PanicException, qui dérive de BaseException) est traitée de même ; un arrêt demandé
    (KeyboardInterrupt, SystemExit, GeneratorExit) n'est jamais avalé."""
    try:
        return read(*args)
    except (KeyboardInterrupt, SystemExit, GeneratorExit):
        raise
    except BaseException:  # enrichissement : jamais une raison de faire échouer l'analyse (panique Rust comprise)
        log.warning("Lecture facultative %s impossible : analyse poursuivie sans elle", what, exc_info=True)
        return pd.DataFrame()


def extract_raw(path: str | Path, sample_rate: int = 32, progress=lambda pct, step: None) -> RawDemo:
    from demoparser2 import DemoParser  # import local : seul point de contact

    parser = DemoParser(str(path))
    progress(5, "header")
    header = parser.parse_header()

    # tous les événements en une seule lecture de la démo (≈ 20× plus rapide qu'un parse_event par événement,
    # résultat identique) ; repli événement par événement si la lecture groupée échoue
    events: dict[str, pd.DataFrame] = {}
    try:
        got = dict(parser.parse_events(EVENTS, player=EVENT_PLAYER_PROPS, other=EVENT_OTHER_PROPS))
        events = {name: got.get(name, pd.DataFrame()) for name in EVENTS}
        events = {k: v if isinstance(v, pd.DataFrame) else pd.DataFrame() for k, v in events.items()}
    except Exception:
        for name in EVENTS:
            events[name] = _safe_event(parser, name, with_props=True)
    progress(40, "events")
    for name in PLAIN_EVENTS:
        events[name] = _safe_event(parser, name, with_props=False)

    starts = events["round_start"]["tick"] if not events["round_start"].empty else pd.Series([1])
    ends = events["round_end"]["tick"] if not events["round_end"].empty else pd.Series([1])
    first_tick, last_tick = int(starts.min()), int(ends.max())

    progress(45, "grenades")
    # grenades=False : projectiles seulement. Les mêmes lignes qu'après le filtre ci-dessous (vérifié le 30/10/2026 sur
    # deux démos), sans les grenades tenues en main : 10 fois moins de lignes, pic de 2,0 Go → 0,9 Go (démo de 677 Mo).
    g = parser.parse_grenades(grenades=False)
    g = g[g["grenade_type"].str.contains("Projectile", na=False)].dropna(subset=["x", "y", "z"])
    g = g.reset_index(drop=True)
    first = g.groupby("grenade_entity_id")["tick"].min() if not g.empty else pd.Series(dtype=int)
    throw_ticks = sorted({int(t) for t in first.tolist()})

    # Chaque parse_ticks relit toute la démo : ticks échantillonnés, instantanés, lancers et sonde du tickrate
    # sont lus ensemble, par passes de TICKS_PER_PASS ticks (pic mémoire borné). Le tickrate (64 en CS2) n'est connu
    # qu'après coup : s'il diffère, on relit les ticks qui en dépendent.
    progress(55, "ticks")
    probe_ticks = _probe_ticks(last_tick)

    def read(rate: int, extra: bool) -> dict[str, pd.DataFrame]:
        groups = {"ticks": (list(range(first_tick, last_tick + 1, frame_step(rate, sample_rate))), TICK_PROPS),
                  "snapshots": (_snapshot_ticks(events, rate, last_tick), SNAPSHOT_PROPS)}
        if extra:
            groups |= {"throws": (throw_ticks, THROW_PROPS), "probe": (probe_ticks, ["game_time"])}
        return _read_ticks(parser, groups, progress)

    got = read(64, extra=True)
    tickrate = _tickrate_from(got["probe"])
    throws = got["throws"]
    if tickrate != 64:
        got = read(tickrate, extra=False)
    ticks, snapshots = got["ticks"], got["snapshots"]
    del got

    # Regard à chaque tick et recul au tir : deux lectures légères APRÈS les passes des images (le tickrate est alors connu et
    # le pic mémoire des passes n'en dépend pas) ; elles ne touchent pas aux passes ci-dessus
    progress(90, "ticks")
    step = frame_step(tickrate, sample_rate)
    off = mid_tick_offset(step)
    mids = [t + off for t in range(first_tick, last_tick + 1, step) if t + off <= last_tick] if off else []
    angles = _optional("des angles du milieu", _read_angles, parser, mids) if mids else pd.DataFrame()
    punch = _optional("du recul de la caméra au tir", _read_punch, parser, events["weapon_fire"])
    forces = _optional("de la force de la mort", _read_forces, parser, events["player_death"])

    progress(90, "done")
    return RawDemo(header=header, tickrate=tickrate, sample_rate=sample_rate,
                   events=events, ticks=ticks, grenades=g, throws=throws, snapshots=snapshots, angles=angles, punch=punch,
                   forces=forces)


def save_raw(raw: RawDemo, directory: str | Path) -> None:
    d = Path(directory)
    (d / "events").mkdir(parents=True, exist_ok=True)
    meta = {"header": raw.header, "tickrate": raw.tickrate, "sample_rate": raw.sample_rate}
    (d / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    for name, df in raw.events.items():
        df.to_parquet(d / "events" / f"{name}.parquet", index=False)
    raw.ticks.to_parquet(d / "ticks.parquet", index=False)
    raw.grenades.to_parquet(d / "grenades.parquet", index=False)
    raw.throws.to_parquet(d / "throws.parquet", index=False)
    raw.snapshots.to_parquet(d / "snapshots.parquet", index=False)
    raw.angles.to_parquet(d / "angles.parquet", index=False)
    raw.punch.to_parquet(d / "punch.parquet", index=False)
    raw.forces.to_parquet(d / "forces.parquet", index=False)


def load_raw(directory: str | Path) -> RawDemo:
    d = Path(directory)
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    events = {p.stem: pd.read_parquet(p) for p in sorted((d / "events").glob("*.parquet"))}
    return RawDemo(header=meta["header"], tickrate=meta["tickrate"], sample_rate=meta["sample_rate"],
                   events=events, ticks=pd.read_parquet(d / "ticks.parquet"),
                   grenades=pd.read_parquet(d / "grenades.parquet"),
                   throws=pd.read_parquet(d / "throws.parquet"),
                   snapshots=pd.read_parquet(d / "snapshots.parquet"),
                   # fixtures d'avant la tâche 1.10 : ni angles du milieu, ni recul ; d'avant le ragdoll : pas de force
                   angles=_read_optional(d / "angles.parquet"), punch=_read_optional(d / "punch.parquet"),
                   forces=_read_optional(d / "forces.parquet"))


def _read_optional(path: Path) -> pd.DataFrame:
    return pd.read_parquet(path) if path.exists() else pd.DataFrame()
