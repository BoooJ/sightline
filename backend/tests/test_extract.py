# backend/tests/test_extract.py
"""Lecture de la démo (extract_raw) avec un faux demoparser2 : props demandées, colonnes gardées, colonnes absentes,
lecture des ticks par passes, inventaires partagés, grenades limitées aux projectiles."""
import gc
import inspect
import logging
import re
import sys
import weakref
from pathlib import Path

import demoparser2
import numpy as np
import pandas as pd
import pytest

from app.parsing import extract
from app.parsing.build import BuildOptions, _RoundSpan, build_frames
from app.parsing.extract import (
    ANGLE_PROPS,
    PARSE_PROPS,
    PARSER_VERSION,
    SNAPSHOT_PROPS,
    THROW_PROPS,
    TICK_PROPS,
    VIEW_PROPS,
    extract_raw,
    frame_step,
)

# colonnes qu'une démo ancienne ne fournit pas (demoparser2 ignore alors la prop sans erreur, vérifié le 30/10/2026
# avec demoparser2 0.42.1 : une prop inconnue ne produit pas de colonne)
ABSENT = {"crosshair_code", "is_airborne"}
ASKED: list[str] = []  # props du dernier parse_ticks des passes d'images (PARSE_PROPS)
PASSES: list[list[int]] = []  # ticks demandés à chaque passe d'images
CALLS: list[tuple[list[str], list[int]]] = []  # (props, ticks) des autres parse_ticks : angles du milieu, recul au tir
GRENADES: list[bool] = []  # argument `grenades` de chaque parse_grenades
PLAYERS = ((76561198000000001, "a"), (76561198000000002, "b"))
# recul de la caméra (view punch) : vecteur [vertical, horizontal, roulis] en degrés, une valeur par joueur et par tick
PUNCH_PROP = "CCSPlayerPawn.CCSPlayer_CameraServices.m_vecCsViewPunchAngle"
# recul de visée (aim punch) des démos CS2 récentes : angle de base posé au tir, lu au même tick et dans le même appel
AIM_PUNCH_PROP = "CCSPlayerPawn.CCSPlayer_AimPunchServices.m_predictableBaseAngle"
# force de la mort (ragdoll du replay 3D) : vecteur [x, y, z] posé sur le pawn de la victime, lu AU tick de player_death
FORCE_PROP = "CCSPlayerPawn.m_vecForce"
# morts du faux round : (tick, indice de la victime) ; aucune par défaut (les autres tests ne lisent pas la force)
DEATHS: list[tuple[int, int]] = []
# tirs du faux round : (tick, indice du joueur, arme) ; le couteau et la fumigène sont lus aussi (le filtre est dans build)
FIRES = [(110, 0, "weapon_ak47"), (111, 1, "weapon_knife"), (130, 0, "weapon_glock"), (131, 1, "weapon_ak47"),
         (200, 1, "weapon_smokegrenade")]


def punch_of(tick: int, sid: int) -> list[float]:
    return [-1.0 - (tick % 50) / 10 - (sid % 3) / 100, ((tick * 3) % 7 - 3) / 10, 0.0]


def aim_of(tick: int, sid: int) -> list[float]:
    return [-(tick % 40) / 20 - (sid % 3) / 100, ((tick * 5) % 9 - 4) / 100, 0.0]


def force_of(tick: int, sid: int) -> list[float]:
    return [24000.0 - tick, float((sid % 7) * 100), -float(tick % 13)]


def inventory(tick: int) -> list[str] | None:
    return None if tick % 3 == 0 else ["Knife", "USP-S"] if tick % 4 == 0 else ["Knife", "Glock-18", "C4 Explosive"]


class FakeParser:
    """Démo d'un round (ticks 100 à 228), deux joueurs ; parse_ticks rend toutes les props demandées sauf ABSENT."""

    def __init__(self, path: str):
        self.path = path

    def parse_header(self):
        return {"map_name": "de_nuke"}

    def parse_events(self, names, player=None, other=None):
        fires = pd.DataFrame({"tick": [t for t, _, _ in FIRES], "user_steamid": [PLAYERS[j][0] for _, j, _ in FIRES],
                              "weapon": [w for _, _, w in FIRES]})
        deaths = pd.DataFrame({"tick": [t for t, _ in DEATHS], "user_steamid": [PLAYERS[j][0] for _, j in DEATHS]})
        return [("round_start", pd.DataFrame({"tick": [100]})), ("round_freeze_end", pd.DataFrame({"tick": [120]})),
                ("round_end", pd.DataFrame({"tick": [228]})), ("weapon_fire", fires), ("player_death", deaths)]

    def parse_event(self, name, player=None, other=None):
        return pd.DataFrame()

    def parse_grenades(self, *, extra=None, grenades=True):
        GRENADES.append(grenades)
        return pd.DataFrame({"grenade_type": pd.Series([], dtype=object), "x": [], "y": [], "z": [],
                             "grenade_entity_id": [], "tick": []})

    def parse_ticks(self, props, ticks):
        if props == PARSE_PROPS:
            ASKED[:] = props
            PASSES.append(list(ticks))
        else:
            CALLS.append((list(props), list(ticks)))
        df = pd.DataFrame([{"tick": t, "steamid": sid, "name": name, "game_time": t / 64}
                           for t in ticks for sid, name in PLAYERS])
        for p in props:
            if p in ABSENT or p == "game_time":
                continue
            if p == PUNCH_PROP:
                df[p] = [punch_of(t, s) for t, s in zip(df["tick"], df["steamid"], strict=True)]
            elif p == AIM_PUNCH_PROP:
                df[p] = [aim_of(t, s) for t, s in zip(df["tick"], df["steamid"], strict=True)]
            elif p == FORCE_PROP:
                df[p] = [force_of(t, s) for t, s in zip(df["tick"], df["steamid"], strict=True)]
            else:
                df[p] = [inventory(t) for t in df["tick"]] if p == "inventory" else df["tick"] * 7 % 11
        return df


@pytest.fixture()
def fake_parser(monkeypatch):
    monkeypatch.setattr(demoparser2, "DemoParser", FakeParser)
    PASSES.clear()
    CALLS.clear()
    GRENADES.clear()


def test_view_props_requested_and_kept(fake_parser):
    raw = extract_raw("faux.dem", sample_rate=32)
    assert set(VIEW_PROPS) <= set(ASKED)
    kept = set(raw.ticks.columns)
    assert set(VIEW_PROPS) - ABSENT <= kept  # duck_amount, touches, munitions… gardées
    assert not ABSENT & kept  # colonnes absentes de la démo : pas d'erreur, pas de colonne
    assert (np.diff(sorted(raw.ticks["tick"].unique())) == 2).all()  # 32 images/s sur une démo à 64 ticks


# FOV de la caméra et réglages des bras : noms complets (le nom court `fov` de demoparser2 vaut toujours 0)
FOV_PROP = "CCSPlayerPawn.CCSPlayer_CameraServices.m_iFOV"
VIEWMODEL_PROPS = ["CCSPlayerPawn.m_flViewmodelFOV", "CCSPlayerPawn.m_flViewmodelOffsetX",
                   "CCSPlayerPawn.m_flViewmodelOffsetY", "CCSPlayerPawn.m_flViewmodelOffsetZ"]


def test_fov_and_viewmodel_props_requested_and_kept(fake_parser):
    raw = extract_raw("faux.dem", sample_rate=32)
    assert {FOV_PROP, *VIEWMODEL_PROPS} <= set(ASKED)  # les 5 props, par leur nom complet
    assert {FOV_PROP, *VIEWMODEL_PROPS} <= set(raw.ticks.columns)
    assert "fov" not in ASKED and "fov" not in raw.ticks.columns  # le nom court vaut toujours 0 : jamais demandé


def test_view_props_list():
    assert VIEW_PROPS == ["duck_amount", "ducking", "is_airborne", "is_walking", "active_weapon_ammo", "total_ammo_left",
                          "zoom_lvl", "crosshair_code", "FORWARD", "BACK", "LEFT", "RIGHT", "JUMP", "FIRE",
                          "RIGHTCLICK", "RELOAD", "USE", "INSPECT", FOV_PROP, *VIEWMODEL_PROPS, "agent_skin", "CCSPlayerPawn.m_MoveType"]
    assert (extract.FOV_PROP, extract.VIEWMODEL_PROPS) == (FOV_PROP, VIEWMODEL_PROPS)
    assert TICK_PROPS[-len(VIEW_PROPS):] == VIEW_PROPS and "pitch" in TICK_PROPS
    assert PARSER_VERSION == "3"
    assert extract.MOVETYPE_PROP == "CCSPlayerPawn.m_MoveType" and extract.MOVETYPE_LADDER == 9  # nom complet : le court vaut 5
    assert extract.THROW_PROPS == ["X", "Y", "Z", "yaw", "pitch"]  # inchangé


def test_default_sample_rate():
    assert inspect.signature(extract_raw).parameters["sample_rate"].default == 32


def test_ticks_read_in_passes_same_result(fake_parser, monkeypatch):
    one = extract_raw("faux.dem", sample_rate=32)  # 66 ticks voulus ≤ TICKS_PER_PASS : une seule passe
    assert len(PASSES) == 1
    PASSES.clear()
    monkeypatch.setattr(extract, "TICKS_PER_PASS", 16)
    many = extract_raw("faux.dem", sample_rate=32)
    assert len(PASSES) == 5 and max(map(len, PASSES)) <= 16
    flat = [t for p in PASSES for t in p]
    assert flat == sorted(set(flat))  # passes dans l'ordre des ticks, chaque tick lu une seule fois
    for name in ("ticks", "snapshots", "throws"):
        pd.testing.assert_frame_equal(getattr(many, name), getattr(one, name), obj=name)
    assert many.tickrate == one.tickrate == 64


def test_inventories_shared_tuples(fake_parser):
    inv = extract_raw("faux.dem", sample_rate=32).ticks["inventory"].tolist()
    assert set(inv) == {(), ("Knife", "USP-S"), ("Knife", "Glock-18", "C4 Explosive")}  # None → ()
    usp = [x for x in inv if x == ("Knife", "USP-S")]
    assert len(usp) > 2 and all(x is usp[0] for x in usp)  # un seul objet par inventaire différent


def test_shared_inventories_missing_cells_are_empty():
    """Cellule absente (None, NaN, pd.NA) = inventaire vide, comme build_frames ; liste, tuple et ndarray = même tuple."""
    items = ["Knife", "USP-S"]
    col = pd.Series([None, float("nan"), pd.NA, items, tuple(items), np.array(items, dtype=object)], dtype=object)
    out = extract._shared_inventories(col, {})
    assert out[:3].tolist() == [(), (), ()]
    assert out[3] == ("Knife", "USP-S") and out[3] is out[4] is out[5]  # un seul objet pour les trois formes


def test_grenades_projectiles_only(fake_parser):
    extract_raw("faux.dem", sample_rate=32)
    assert GRENADES == [False]  # projectiles seulement : mêmes lignes après le filtre « Projectile »


# --------------------------------------------------------------------------- pic mémoire : colonnes gardées et types compacts

# colonnes de raw.ticks que personne ne relit (build_frames n'en lit aucune) ; les instantanés gardent les leurs
DROPPED = {"name", "team_clan_name", "last_place_name", "is_warmup_period", "is_freeze_period", "total_rounds_played",
           "team_rounds_total", "round_start_equip_value"}
WEAPONS = ("weapon_ak47", "weapon_awp", "weapon_knife")


class TypedParser(FakeParser):
    """Comme une vraie démo : textes, booléens à trous (joueur sans pawn : None), entiers avec NaN, flottants inexacts."""

    def parse_ticks(self, props, ticks):
        df = super().parse_ticks(props, ticks)
        tick, sid = df["tick"].to_numpy(), df["steamid"].to_numpy()
        df["active_weapon_name"] = pd.Series([None if t % 7 == 0 else WEAPONS[t % 3] for t in tick])
        df["crosshair_code"] = ["CSGO-A" if s == PLAYERS[0][0] and t > 130 else None for t, s in zip(tick, sid, strict=True)]
        df["ducking"] = pd.Series([None if t % 5 == 0 else t % 4 == 0 for t in tick], dtype=object)
        df["health"] = np.where(tick % 11 == 0, np.nan, tick % 100).astype(np.float64)
        df["CCSPlayerPawn.m_flViewmodelOffsetX"] = 0.1  # float64 qui n'est pas un float32 : doit rester float64
        if "agent_skin" in df.columns:  # agent équipé (texte), agent par défaut pour les autres
            df["agent_skin"] = ["customplayer_tm_leet_variantf" if x == PLAYERS[0][0] else "customplayer_t_map_based" for x in sid]
        return df


@pytest.fixture()
def typed_parser(monkeypatch):
    monkeypatch.setattr(demoparser2, "DemoParser", TypedParser)
    PASSES.clear()
    CALLS.clear()
    GRENADES.clear()


def test_ticks_keep_only_the_columns_build_frames_reads(fake_parser):
    raw = extract_raw("faux.dem", sample_rate=32)
    assert set(raw.ticks.columns) <= set(TICK_PROPS) | {"tick", "steamid"}
    assert not DROPPED & set(raw.ticks.columns)  # ni nom, ni clan, ni lieu, ni score, ni phase du round
    # inchangé pour les instantanés (noms et clans de build_demo)
    assert {"name", *SNAPSHOT_PROPS} <= set(raw.snapshots.columns)
    # parse_ticks reçoit l'union des props des groupes, sans lieu ni phase du round que personne ne lit
    assert set(ASKED) == set(PARSE_PROPS) == set(TICK_PROPS) | set(SNAPSHOT_PROPS) | set(THROW_PROPS) | {"game_time"}
    assert not {"last_place_name", "is_warmup_period", "is_freeze_period"} & set(ASKED)


def test_ticks_compact_types_same_values(typed_parser, monkeypatch):
    monkeypatch.setattr(extract, "TICKS_PER_PASS", 16)  # plusieurs passes : les catégories apparaissent en cours de route
    t = extract_raw("faux.dem", sample_rate=32).ticks
    assert len(PASSES) > 3
    tick = t["tick"].to_numpy()
    maybe = lambda x: None if pd.isna(x) else x
    # textes → catégories, mêmes valeurs (manquant = NaN, comme avant)
    assert t["active_weapon_name"].dtype == "category" and t["crosshair_code"].dtype == "category"
    assert [maybe(x) for x in t["active_weapon_name"]] == [None if k % 7 == 0 else WEAPONS[k % 3] for k in tick]
    assert [maybe(x) for x in t["crosshair_code"]] == ["CSGO-A" if s == PLAYERS[0][0] and k > 130 else None
                                                       for k, s in zip(tick, t["steamid"], strict=True)]
    assert set(t["active_weapon_name"].cat.categories) == set(WEAPONS)
    # agent équipé : catégorie aussi, mêmes valeurs
    assert t["agent_skin"].dtype == "category"
    assert [str(x) for x in t["agent_skin"]] == ["customplayer_tm_leet_variantf" if s == PLAYERS[0][0] else "customplayer_t_map_based"
                                                 for s in t["steamid"]]
    # booléens à trous → bool (None compte pour faux, comme dans build_frames)
    assert t["ducking"].dtype == bool
    assert t["ducking"].tolist() == [k % 5 != 0 and k % 4 == 0 for k in tick]
    # flottant exact → float32 (NaN gardés) ; flottant inexact → inchangé
    assert t["health"].dtype == np.float32
    assert np.array_equal(t["health"].to_numpy(np.float64), np.where(tick % 11 == 0, np.nan, tick % 100), equal_nan=True)
    assert t["CCSPlayerPawn.m_flViewmodelOffsetX"].dtype == np.float64 and (t["CCSPlayerPawn.m_flViewmodelOffsetX"] == 0.1).all()
    # les inventaires restent des tuples, `tick` et `steamid` ne changent pas de type
    assert isinstance(t["inventory"].iloc[0], tuple) and t["tick"].dtype == np.int64 and t["steamid"].dtype == np.int64


def test_ticks_compact_same_result_in_one_or_many_passes(typed_parser, monkeypatch):
    one = extract_raw("faux.dem", sample_rate=32).ticks
    monkeypatch.setattr(extract, "TICKS_PER_PASS", 10)
    pd.testing.assert_frame_equal(extract_raw("faux.dem", sample_rate=32).ticks, one)


def test_plain_bools_only_true_false_none():
    obj = lambda *x: np.array(x, dtype=object)
    assert extract._plain_bools(obj(True, None, False, np.bool_(True))).tolist() == [True, False, False, True]
    assert extract._plain_bools(obj(None, None)).tolist() == [False, False]
    for other in (obj(True, float("nan")), obj(True, pd.NA), obj(True, 1), obj(True, "x"), obj(("a",), None)):
        assert extract._plain_bools(other) is None  # NaN, entiers, textes… ont un sens propre dans build_frames : inchangés


def test_exact_float32_only_when_lossless():
    exact = np.array([0.0, 1.5, -3.0, 16777216.0, np.nan], dtype=np.float64)
    assert extract._exact_float32(exact).dtype == np.float32
    assert np.array_equal(extract._exact_float32(exact).astype(np.float64), exact, equal_nan=True)
    # 0,1 et 2^24 + 1 perdent un bit ; 2^32 - 1 aussi ; 1e300 déborde (sans avertissement) : colonne inchangée
    for lossy in ([0.1], [16777217.0], [4294967295.0], [1e300], [1.0, 0.1, np.nan]):
        assert extract._exact_float32(np.array(lossy, dtype=np.float64)) is None, lossy
    assert extract._exact_float32(np.array([np.inf, -np.inf, 2.0 ** 100])).dtype == np.float32  # exacts


def test_categorical_column_missing_from_a_pass():
    books: dict = {}
    parts = [extract._compact(pd.DataFrame({"tick": [1, 2], "active_weapon_name": ["ak", None]}), books),
             extract._compact(pd.DataFrame({"tick": [3, 4]}), books),  # colonne absente de cette passe
             extract._compact(pd.DataFrame({"tick": [5, 6], "active_weapon_name": ["awp", "ak"]}), books)]
    full = extract._categorical(pd.concat(parts, ignore_index=True), books)
    assert full["active_weapon_name"].dtype == "category"
    assert [None if pd.isna(x) else x for x in full["active_weapon_name"]] == ["ak", None, None, None, "awp", "ak"]
    assert list(full["active_weapon_name"].cat.categories) == ["ak", "awp"]  # ordre d'apparition


def test_categorical_column_without_any_value():
    books: dict = {}
    part = extract._compact(pd.DataFrame({"tick": [1, 2], "crosshair_code": [None, None]}), books)
    full = extract._categorical(part, books)
    assert full["crosshair_code"].dtype == "category" and full["crosshair_code"].isna().all()


def test_only_build_frames_reads_raw_ticks():
    """Les colonnes que extract_raw ne garde plus ne sont lues nulle part : raw.ticks n'est lu que par build.py (et écrit
    en Parquet par save_raw, dans extract.py)."""
    app = Path(extract.__file__).parents[1]
    readers = sorted(p.name for p in app.rglob("*.py") if re.search(r"\braw\w*\.ticks\b", p.read_text(encoding="utf-8")))
    assert readers == ["build.py", "extract.py"]


def test_save_and_load_raw_keep_compact_types(typed_parser, tmp_path):
    """Les fixtures Parquet (save_raw / load_raw) relisent les colonnes compactes telles quelles."""
    raw = extract_raw("faux.dem", sample_rate=32)
    extract.save_raw(raw, tmp_path)
    back = extract.load_raw(tmp_path).ticks
    cols = [c for c in raw.ticks.columns if c != "inventory"]  # les inventaires reviennent en listes, comme avant
    assert back["active_weapon_name"].dtype == "category" and back["ducking"].dtype == bool
    pd.testing.assert_frame_equal(back[cols], raw.ticks[cols])


# --------------------------------------------------------------------------- regard à 64 images/s et recul au tir (tâche 1.10)

def mid_ticks() -> list[int]:
    """Ticks entre deux images de la fausse démo (images tous les 2 ticks de 100 à 228) : 101, 103… 227."""
    return list(range(101, 228, 2))


def angle_calls() -> list[list[int]]:
    return [t for props, t in CALLS if props == ANGLE_PROPS]


def punch_calls() -> list[list[int]]:
    return [t for props, t in CALLS if props == [PUNCH_PROP, AIM_PUNCH_PROP]]


def test_mid_tick_angles_read_apart(fake_parser):
    """Angles du milieu : un appel à part, avec les deux angles seulement, sur les ticks situés entre deux images ; les
    passes des images ne changent pas (mêmes ticks, mêmes props)."""
    raw = extract_raw("faux.dem", sample_rate=32)
    assert ANGLE_PROPS == ["yaw", "pitch"]
    assert [t for chunk in angle_calls() for t in chunk] == mid_ticks()
    assert len(PASSES) == 1 and set(range(100, 229, 2)) <= set(PASSES[0])  # une seule passe des images, comme avant
    assert not set(mid_ticks()) & set(PASSES[0])  # les ticks du milieu n'y sont pas lus (pas de lecture en plus des images)
    a = raw.angles
    assert list(a.columns) == ["tick", "steamid", "yaw", "pitch"]  # ni nom, ni autre prop
    assert len(a) == 2 * len(mid_ticks()) and set(a["tick"]) == set(mid_ticks())
    assert a["yaw"].dtype == np.float32 and a["pitch"].dtype == np.float32
    assert np.array_equal(a["yaw"].to_numpy(), (a["tick"] * 7 % 11).to_numpy().astype(np.float32))
    assert set(a["steamid"]) == {sid for sid, _ in PLAYERS}


def test_mid_tick_angles_same_in_one_or_many_passes(fake_parser, monkeypatch):
    one = extract_raw("faux.dem", sample_rate=32)
    assert len(angle_calls()) == 1
    CALLS.clear()
    monkeypatch.setattr(extract, "ANGLE_TICKS_PER_PASS", 10)
    many = extract_raw("faux.dem", sample_rate=32)
    assert len(angle_calls()) == 7 and max(map(len, angle_calls())) <= 10
    flat = [t for chunk in angle_calls() for t in chunk]
    assert flat == sorted(set(flat))  # dans l'ordre des ticks, chaque tick lu une fois
    pd.testing.assert_frame_equal(many.angles, one.angles)
    pd.testing.assert_frame_equal(many.punch, one.punch)


def test_mid_tick_angles_none_when_no_tick_between_images(fake_parser):
    """64 images/s sur une démo à 64 ticks : une image par tick, aucun tick entre deux images → rien lu, rien gardé."""
    raw = extract_raw("faux.dem", sample_rate=64)
    assert angle_calls() == [] and raw.angles.empty
    assert len(PASSES) == 1 and set(range(100, 229)) <= set(PASSES[0])


def test_mid_tick_is_rounded_for_a_longer_step(fake_parser):
    """16 images/s (une image tous les 4 ticks) : le tick du milieu est à +2 ; au pas de 3 ticks, arrondi à +1."""
    extract_raw("faux.dem", sample_rate=16)
    assert [t for chunk in angle_calls() for t in chunk] == list(range(102, 229, 4))
    assert extract.mid_tick_offset(2) == 1 and extract.mid_tick_offset(3) == 1 and extract.mid_tick_offset(4) == 2
    assert extract.mid_tick_offset(1) == 0  # pas de tick entre deux images


def test_shot_punch_read_at_the_tick_of_the_shot(fake_parser):
    """Recul au tir : valeur du view punch lue AU tick du tir (l'événement weapon_fire est émis avant la mise à jour de
    la prop : la valeur de l'événement serait celle du tir d'avant, vérifié le 31/10/2026), pour le tireur seulement."""
    raw = extract_raw("faux.dem", sample_rate=32)
    assert (extract.PUNCH_PROP, extract.AIM_PUNCH_PROP) == (PUNCH_PROP, AIM_PUNCH_PROP)
    assert punch_calls() == [sorted({t for t, _, _ in FIRES})]  # un seul appel (les deux reculs), aux seuls ticks des tirs
    p = raw.punch
    assert list(p.columns) == ["tick", "steamid", "punch_pitch", "punch_yaw", "aim_pitch", "aim_yaw"]
    assert len(p) == len(FIRES)  # une ligne par tir : le tireur, pas les autres joueurs
    for (tick, j, _), row in zip(FIRES, p.sort_values("tick").itertuples(), strict=True):
        sid = PLAYERS[j][0]
        want, aim = punch_of(tick, sid), aim_of(tick, sid)
        assert (row.tick, row.steamid) == (tick, sid)
        assert row.punch_pitch == pytest.approx(want[0], abs=1e-6) and row.punch_yaw == pytest.approx(want[1], abs=1e-6)
        assert row.aim_pitch == pytest.approx(aim[0], abs=1e-6) and row.aim_yaw == pytest.approx(aim[1], abs=1e-6)
    assert all(p[c].dtype == np.float32 for c in ("punch_pitch", "punch_yaw", "aim_pitch", "aim_yaw"))


def test_shot_aim_punch_absent_from_the_demo(fake_parser, monkeypatch):
    """Démo sans le recul de visée (ancienne : pas de CCSPlayer_AimPunchServices) : recul de caméra gardé, visée en NaN."""
    monkeypatch.setattr(sys.modules[__name__], "ABSENT", {*ABSENT, AIM_PUNCH_PROP})
    p = extract_raw("faux.dem", sample_rate=32).punch
    assert len(p) == len(FIRES) and p["punch_pitch"].notna().all()
    assert p["aim_pitch"].isna().all() and p["aim_yaw"].isna().all()


def test_shot_aim_punch_failure_keeps_the_camera_punch(monkeypatch, caplog):
    """Le parseur lève une exception (ou panique) sur l'appel des deux reculs à cause de la prop de visée : nouvel essai
    avec le seul recul de la caméra, gardé pour chaque tir ; visée en NaN, un avertissement, et des images à 4 valeurs."""
    monkeypatch.setattr(sys.modules[__name__], "FAIL_ON", [[PUNCH_PROP, AIM_PUNCH_PROP]])
    monkeypatch.setattr(demoparser2, "DemoParser", FailingParser)
    PASSES.clear()
    CALLS.clear()
    GRENADES.clear()
    with caplog.at_level(logging.WARNING, logger=extract.__name__):
        raw = extract_raw("faux.dem", sample_rate=32)
    assert [t for props, t in CALLS if props == [PUNCH_PROP]] == [sorted({t for t, _, _ in FIRES})]
    p = raw.punch
    assert len(p) == len(FIRES) and p["punch_pitch"].notna().all() and p["aim_pitch"].isna().all()
    warned = [r for r in caplog.records if r.name == extract.__name__ and r.levelno >= logging.WARNING]
    assert len(warned) == 1 and "visée" in warned[0].getMessage()
    raw.ticks = raw.ticks.assign(team_num=2)
    fr = build_frames(raw, [_RoundSpan(1, 100, 120, 228, 10 ** 9, "CT", None)], BuildOptions())[1]
    assert fr.punch and all(len(x) == 4 for x in fr.punch)  # tirs des armes à feu, recul de la caméra seul


def test_shot_punch_absent_from_the_demo(fake_parser, monkeypatch):
    """Démo sans la prop (ancienne) : pas de colonne, pas d'erreur, tableau vide."""
    monkeypatch.setattr(sys.modules[__name__], "ABSENT", {*ABSENT, PUNCH_PROP})
    raw = extract_raw("faux.dem", sample_rate=32)
    assert raw.punch.empty and not raw.angles.empty


def test_shot_punch_without_any_shot(fake_parser, monkeypatch):
    monkeypatch.setattr(sys.modules[__name__], "FIRES", [])
    raw = extract_raw("faux.dem", sample_rate=32)
    assert raw.punch.empty and punch_calls() == []  # aucun tir : aucune lecture


def test_raw_angles_and_punch_survive_save_and_load(fake_parser, tmp_path):
    raw = extract_raw("faux.dem", sample_rate=32)
    extract.save_raw(raw, tmp_path)
    back = extract.load_raw(tmp_path)
    pd.testing.assert_frame_equal(back.angles, raw.angles)
    pd.testing.assert_frame_equal(back.punch, raw.punch)
    (tmp_path / "angles.parquet").unlink()
    (tmp_path / "punch.parquet").unlink()  # fixture d'avant la tâche : les deux tableaux sont simplement vides
    old = extract.load_raw(tmp_path)
    assert old.angles.empty and old.punch.empty


def test_read_ticks_frees_the_chunks_before_the_last_steps(fake_parser, monkeypatch):
    """Les morceaux de chaque groupe sont libérés dès la concaténation : ils n'existent plus en même temps que le
    tableau complet quand _categorical s'exécute (pic mémoire des grosses démos)."""
    chunks: list = []
    real = extract._compact

    def spy(part, books):
        out = real(part, books)
        chunks.append(weakref.ref(out))
        return out

    seen: list[int] = []
    real_cat = extract._categorical

    def cat(full, books):
        gc.collect()
        seen.append(sum(r() is not None for r in chunks))
        return real_cat(full, books)

    monkeypatch.setattr(extract, "_compact", spy)
    monkeypatch.setattr(extract, "_categorical", cat)
    monkeypatch.setattr(extract, "TICKS_PER_PASS", 16)
    extract_raw("faux.dem", sample_rate=32)
    assert len(chunks) > 3 and seen == [0]


# --------------------------------------------------------------------------- lectures facultatives : jamais d'échec de l'analyse

FAIL_ON: list[list[str]] = []  # props des appels qui lèvent une exception


class FailingParser(FakeParser):
    """Comme FakeParser, mais le parseur lève une exception sur l'un des deux appels facultatifs (angles du milieu ou recul)."""

    def parse_ticks(self, props, ticks):
        if list(props) in FAIL_ON:
            raise RuntimeError("prop inconnue de cette démo")
        return super().parse_ticks(props, ticks)


# recul : l'appel des deux reculs ET le nouvel essai avec le seul recul de la caméra échouent
@pytest.mark.parametrize("fail_on, label", [([ANGLE_PROPS], "angles"), ([[PUNCH_PROP, AIM_PUNCH_PROP], [PUNCH_PROP]], "recul")])
def test_optional_reads_degrade_to_empty_frames(monkeypatch, caplog, fail_on, label):
    """Un échec de demoparser2 sur les angles du milieu ou sur le recul ne fait pas échouer l'analyse (elle réussit
    aujourd'hui sur toutes les démos du serveur) : le tableau concerné est vide, un avertissement est écrit, le reste
    est intact. build_frames donne alors des images sans yawm / pitchm ou sans tirs."""
    monkeypatch.setattr(sys.modules[__name__], "FAIL_ON", fail_on)
    monkeypatch.setattr(demoparser2, "DemoParser", FailingParser)
    PASSES.clear()
    CALLS.clear()
    GRENADES.clear()
    with caplog.at_level(logging.WARNING, logger=extract.__name__):
        raw = extract_raw("faux.dem", sample_rate=32)
    warned = [r for r in caplog.records if r.name == extract.__name__ and r.levelno >= logging.WARNING]
    assert [label in r.getMessage() for r in warned] == [True]  # prévenu une seule fois, et de la bonne lecture
    ok, lost = (raw.punch, raw.angles) if fail_on == [ANGLE_PROPS] else (raw.angles, raw.punch)
    assert lost.empty and not ok.empty  # l'autre lecture n'est pas touchée
    assert len(raw.ticks) == 2 * len(range(100, 229, 2))  # images, instantanés : comme sans panne
    assert len(PASSES) == 1 and not raw.snapshots.empty
    # et la construction des images s'en passe : pas de champs du milieu, ou pas de tirs
    raw.ticks = raw.ticks.assign(team_num=2)  # le faux parseur donne des équipes quelconques ; une seule équipe suffit ici
    fr = build_frames(raw, [_RoundSpan(1, 100, 120, 228, 10 ** 9, "CT", None)], BuildOptions())[1]
    if fail_on == [ANGLE_PROPS]:
        assert not {"yawm", "pitchm"} & set(fr.fields) and fr.punch
    else:
        assert {"yawm", "pitchm"} <= set(fr.fields) and fr.punch == []


def test_both_optional_reads_failing(monkeypatch, caplog):
    class Broken(FakeParser):
        def parse_ticks(self, props, ticks):
            if props == PARSE_PROPS:
                return super().parse_ticks(props, ticks)
            raise OSError("lecture impossible")

    monkeypatch.setattr(demoparser2, "DemoParser", Broken)
    with caplog.at_level(logging.WARNING, logger=extract.__name__):
        raw = extract_raw("faux.dem", sample_rate=32)
    assert raw.angles.empty and raw.punch.empty and not raw.ticks.empty
    assert len([r for r in caplog.records if r.name == extract.__name__ and r.levelno == logging.WARNING]) == 2


class PanicException(BaseException):
    """Comme pyo3_runtime.PanicException (panique Rust de demoparser2) : dérive de BaseException, pas d'Exception."""


def _raising_on_optional(exc: BaseException):
    class Panicking(FakeParser):
        def parse_ticks(self, props, ticks):
            if props == PARSE_PROPS:
                return super().parse_ticks(props, ticks)
            raise exc
    return Panicking


def test_rust_panic_in_optional_reads_degrades(monkeypatch, caplog):
    """Une panique Rust dans une lecture facultative (ticks du milieu jamais lus avant, prop du recul) dégrade
    l'analyse comme une exception ordinaire, au lieu de la faire échouer."""
    monkeypatch.setattr(demoparser2, "DemoParser", _raising_on_optional(PanicException("index out of bounds")))
    with caplog.at_level(logging.WARNING, logger=extract.__name__):
        raw = extract_raw("faux.dem", sample_rate=32)
    assert raw.angles.empty and raw.punch.empty and not raw.ticks.empty
    assert len([r for r in caplog.records if r.name == extract.__name__ and r.levelno == logging.WARNING]) == 2


@pytest.mark.parametrize("exc", [KeyboardInterrupt(), SystemExit(1), GeneratorExit()])
def test_optional_reads_never_swallow_interrupts(monkeypatch, exc):
    """Arrêt demandé (Ctrl+C, sortie du processus, fermeture d'un générateur) : jamais avalé par une lecture facultative."""
    monkeypatch.setattr(demoparser2, "DemoParser", _raising_on_optional(exc))
    with pytest.raises(type(exc)):
        extract_raw("faux.dem", sample_rate=32)


# --------------------------------------------------------------------------- un seul pas entre deux images

def test_frame_step():
    assert frame_step(64, 32) == 2 and frame_step(64, 16) == 4 and frame_step(128, 32) == 4
    assert frame_step(64, 64) == 1 and frame_step(64, 128) == 1  # jamais moins de 1 tick par image


def test_the_frame_step_has_a_single_definition():
    """L'écart entre deux images (grille des images, ticks du milieu, vérification de build_frames, fenêtre des
    aveuglements) vient d'une seule fonction : la division par sample_rate n'apparaît qu'une fois dans app/."""
    app = Path(extract.__file__).parents[1]
    hits = sorted((p.name, m) for p in app.rglob("*.py") for m in re.findall(r"//\s*(?:raw\.)?sample_rate", p.read_text(encoding="utf-8")))
    assert hits == [("extract.py", "// sample_rate")]


def test_image_grid_and_mid_ticks_follow_the_same_step(fake_parser):
    raw = extract_raw("faux.dem", sample_rate=16)
    step = frame_step(64, 16)
    assert sorted(raw.ticks["tick"].unique().tolist()) == list(range(100, 229, step))  # grille des images
    assert [t for chunk in angle_calls() for t in chunk] == [t + step // 2 for t in range(100, 229, step) if t + step // 2 <= 228]


# --------------------------------------------------------------------------- force de la mort (ragdoll du replay 3D)

def force_calls() -> list[list[int]]:
    return [t for props, t in CALLS if props == [FORCE_PROP]]


def test_death_force_read_at_the_tick_of_the_death(fake_parser, monkeypatch):
    """Force de la mort lue AU tick de chaque player_death (au tick − 1, c'est encore celle d'une vie précédente : sonde
    du 06/11/2026), pour la victime seulement (pas les autres joueurs du tick), en un seul appel ; une mort en double
    (même tick, même victime) ne donne qu'une ligne."""
    monkeypatch.setattr(sys.modules[__name__], "DEATHS", [(150, 0), (190, 1), (150, 0)])
    raw = extract_raw("faux.dem", sample_rate=32)
    assert extract.FORCE_PROP == FORCE_PROP
    assert force_calls() == [[150, 190]]
    f = raw.forces.sort_values("tick").reset_index(drop=True)
    assert list(f.columns) == ["tick", "steamid", "fx", "fy", "fz"] and len(f) == 2
    for (tick, j), row in zip([(150, 0), (190, 1)], f.itertuples(), strict=True):
        assert (row.tick, row.steamid) == (tick, PLAYERS[j][0])
        assert [row.fx, row.fy, row.fz] == pytest.approx(force_of(tick, PLAYERS[j][0]), abs=1e-3)
    assert all(f[c].dtype == np.float32 for c in ("fx", "fy", "fz"))


def test_death_force_absent_from_the_demo(fake_parser, monkeypatch):
    """Démo sans la prop (ancienne) : pas de colonne, pas d'erreur, tableau vide ; le reste de l'analyse est intact."""
    monkeypatch.setattr(sys.modules[__name__], "DEATHS", [(150, 0)])
    monkeypatch.setattr(sys.modules[__name__], "ABSENT", {*ABSENT, FORCE_PROP})
    raw = extract_raw("faux.dem", sample_rate=32)
    assert raw.forces.empty and not raw.punch.empty and not raw.ticks.empty


def test_death_force_without_any_death(fake_parser):
    raw = extract_raw("faux.dem", sample_rate=32)
    assert raw.forces.empty and force_calls() == []  # aucune mort : aucune lecture


def test_death_force_failure_degrades(monkeypatch, caplog):
    """Le parseur lève une exception (ou panique) sur la force : tableau vide, un seul avertissement, rien d'autre perdu
    (une démo qui s'analyse aujourd'hui s'analyse toujours)."""
    monkeypatch.setattr(sys.modules[__name__], "DEATHS", [(150, 0)])
    monkeypatch.setattr(sys.modules[__name__], "FAIL_ON", [[FORCE_PROP]])
    monkeypatch.setattr(demoparser2, "DemoParser", FailingParser)
    PASSES.clear()
    CALLS.clear()
    GRENADES.clear()
    with caplog.at_level(logging.WARNING, logger=extract.__name__):
        raw = extract_raw("faux.dem", sample_rate=32)
    warned = [r for r in caplog.records if r.name == extract.__name__ and r.levelno >= logging.WARNING]
    assert ["force" in r.getMessage() for r in warned] == [True]
    assert raw.forces.empty and not raw.punch.empty and not raw.angles.empty and len(PASSES) == 1


def test_death_force_survives_save_and_load(fake_parser, monkeypatch, tmp_path):
    monkeypatch.setattr(sys.modules[__name__], "DEATHS", [(150, 0)])
    raw = extract_raw("faux.dem", sample_rate=32)
    extract.save_raw(raw, tmp_path)
    pd.testing.assert_frame_equal(extract.load_raw(tmp_path).forces, raw.forces)
    (tmp_path / "forces.parquet").unlink()  # fixture d'avant ce plan : tableau vide
    assert extract.load_raw(tmp_path).forces.empty
