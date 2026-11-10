"""Normalisation RawDemo -> ParsedDemo, validée sur des fixtures extraites de vraies démos.

nuke_sample          : 3DMAX vs FaZe (eBot), 23 rounds, 3DMAX 13 - 10 FaZe ; ticks des 3 premiers rounds.
faceit_mirage_sample : FACEIT, faux round d'avant-match + restarts, team_Snape- 13 - 11 team_sk1zy ; ticks 2 rounds.
"""
import dataclasses
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.parsing.build import (
    BuildOptions, _agents, _death_forces, _fill_missing_positions, _reserve_mags, _round_forces, _RoundSpan, _viewmodels,
    build_blinds, build_frames, buy_type,
    build_demo, compute_round_spans, mark_openings_and_trades,
)
from app.parsing.extract import TICK_PROPS, RawDemo, _categorical, _compact, load_raw
from app.parsing.model import (
    FLAG_AIRBORNE, FLAG_ALIVE, FLAG_LADDER, KEY_DUCK, KEY_FIRE, KEY_FORWARD, KEY_WALK, NO_AMMO, PGrenade, PKill, PRoundFrames,
)

FIX = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def nuke():
    return build_demo(load_raw(FIX / "nuke_sample"))


@pytest.fixture(scope="module")
def faceit():
    return build_demo(load_raw(FIX / "faceit_mirage_sample"))


def team(demo, name):
    return next(t for t in demo.teams if t.name == name)


def test_nuke_rounds_and_score(nuke):
    assert nuke.map_name == "de_nuke"
    assert nuke.tickrate == 64
    assert [r.number for r in nuke.rounds] == list(range(1, 24))
    faze, tdm = team(nuke, "FaZe"), team(nuke, "3DMAX")
    assert nuke.score[tdm.key] == 13 and nuke.score[faze.key] == 10
    r1, r13 = nuke.rounds[0], nuke.rounds[12]
    assert r1.ct_team_key == faze.key and r13.ct_team_key == tdm.key  # changement de side à la mi-temps
    assert (r13.score_ct_before, r13.score_t_before) == (5, 7)  # FaZe mène 7-5 à la mi-temps
    assert r1.ct_buy_type == r1.t_buy_type == r13.ct_buy_type == "pistol"
    assert nuke.rounds[3].end_reason == "bomb_defused" and nuke.rounds[3].winner_side == "CT"


def test_nuke_players(nuke):
    assert len(nuke.players) == 10
    by_team = {t.key: [p for p in nuke.players if p.team_key == t.key] for t in nuke.teams}
    assert all(len(v) == 5 for v in by_team.values())
    names = {p.name for p in by_team[team(nuke, "FaZe").key]}
    assert {"karrigan", "rain", "broky", "frozen", "jcobbb"} == names


def test_faceit_prematch_is_dropped(faceit):
    assert len(faceit.rounds) == 24
    snape, sk1zy = team(faceit, "team_Snape-"), team(faceit, "team_sk1zy")
    assert faceit.score[snape.key] == 13 and faceit.score[sk1zy.key] == 11
    assert faceit.rounds[0].start_tick >= 2747


def test_kills_openings_trades(nuke):
    assert len(nuke.kills) == 151
    openings = [k for k in nuke.kills if k.is_opening]
    assert len(openings) == 23
    assert all(k.round_number == i + 1 for i, k in enumerate(openings))
    assert any(k.is_trade for k in nuke.kills)
    first = nuke.kills[0]
    assert first.weapon == "usp_silencer" and first.headshot and first.attacker_pos is not None


def test_trade_rule():
    def k(tick, a, v):
        return PKill(1, tick, a, v, None, False, "ak47", False, 0, False, False, False, None, (0, 0, 0))
    kills = [k(100, "t1", "ct1"), k(200, "ct2", "t1"), k(1000, "ct3", "t2")]
    # équipes : t* = 2, ct* = 3
    mark_openings_and_trades(kills, [2, 3, 3], [3, 2, 2], window_ticks=320)
    assert kills[0].is_opening and not kills[1].is_opening
    assert kills[1].is_trade and kills[1].traded_player == "ct1"
    assert not kills[2].is_trade


def test_buy_type_thresholds():
    o = BuildOptions()
    assert buy_type(1, 30000, o) == "pistol" and buy_type(13, 0, o) == "pistol"
    assert buy_type(2, 4000, o) == "eco"
    assert buy_type(2, 8000, o) == "semi"
    assert buy_type(2, 15000, o) == "force"
    assert buy_type(2, 24000, o) == "full"


def test_events_present(nuke):
    rn = {1, 2, 3}
    gr = [g for g in nuke.grenades if g.round_number in rn]
    assert {"smoke", "flash", "he"} <= {g.type for g in gr}
    smokes = [g for g in gr if g.type == "smoke"]
    assert all(g.detonate_pos is not None and g.end_tick and g.end_tick > g.detonate_tick for g in smokes)
    assert any(g.type in ("molotov", "incendiary") and g.end_tick for g in gr)
    assert all(len(g.trajectory) >= 2 for g in gr)
    assert sum(1 for e in nuke.bomb_events if e.type == "plant") == 10
    assert len(nuke.purchases) > 500
    assert nuke.shots and nuke.damages


def test_frames(nuke):
    assert set(nuke.frames) == {1, 2, 3}
    fr = nuke.frames[2]
    assert len(fr.players) == 10
    assert (fr.ticks[1:] - fr.ticks[:-1] == 4).all()
    assert fr.fields["x"].shape == (len(fr.ticks), 10)
    assert (fr.fields["flags"][0] & FLAG_ALIVE).all()  # tout le monde vivant au début
    assert fr.fields["hp"][0].max() == 100
    assert any(w for w in fr.weapons)


def test_blinds(nuke):
    blinds = [b for b in nuke.blinds if b.round_number <= 3]
    assert blinds and any(b.attacker for b in blinds)


def test_damage_real_and_sides(nuke):
    from collections import defaultdict
    per_victim_round = defaultdict(int)
    for d in nuke.damages:
        assert d.dmg_health_real <= d.dmg_health
        per_victim_round[(d.round_number, d.victim)] += d.dmg_health_real
    assert max(per_victim_round.values()) <= 100
    first_kill_dmg = next(d for d in nuke.damages if d.tick == 1678)
    assert first_kill_dmg.dmg_health == 132 and first_kill_dmg.dmg_health_real == 100
    assert {d.attacker_side for d in nuke.damages if d.attacker} <= {"CT", "T"}
    assert all(k.victim_side in ("CT", "T") for k in nuke.kills)


# --------------------------------------------------------------------------- vue du joueur (PARSER_VERSION 3)

XHAIR = "CSGO-G2Zz6-mGBLn-MHzzc-RYnkA-vZ9GJ"
FOV_COL = "CCSPlayerPawn.CCSPlayer_CameraServices.m_iFOV"
VM_COLS = ["CCSPlayerPawn.m_flViewmodelFOV", "CCSPlayerPawn.m_flViewmodelOffsetX",
           "CCSPlayerPawn.m_flViewmodelOffsetY", "CCSPlayerPawn.m_flViewmodelOffsetZ"]
VM_A = [68.0, 2.5, 0.0, -1.5]  # réglage habituel du joueur 0
VM_B = [54.0, 0.0, 0.0, 0.0]  # réglage passager du joueur 0 (minoritaire, mais c'est le dernier du round 2)
VM_D = [62.0, 1.5, -2.0, -2.0]  # réglage du joueur 1 à partir du round 3


@pytest.fixture(scope="module")
def nuke_view():
    """Fixture Nuke + colonnes de la vue du joueur, valeurs fonction du tick (les mêmes pour les 10 joueurs)."""
    raw = load_raw(FIX / "nuke_sample")
    t = raw.ticks
    k = t["tick"].to_numpy() // 4
    t["duck_amount"] = np.float32(0.25)
    t["ducking"] = k % 2 == 0
    t["is_walking"] = k % 3 == 0
    t["is_airborne"] = k % 5 == 0
    t["CCSPlayerPawn.m_MoveType"] = np.where(k % 7 == 0, 9, 2).astype(np.uint64)  # 9 : sur une échelle, 2 : marche
    t["active_weapon_ammo"] = np.where(k % 2 == 0, 30.0, np.nan)  # NaN : pas d'arme à feu en main
    t["total_ammo_left"] = np.where(k % 3 == 0, 4294967295.0, 2.0)  # -1 relu en uint32 : inconnu ; 2 : démo déjà en chargeurs
    t["zoom_lvl"] = np.where(k % 4 == 0, 2.0, np.nan)
    t["FORWARD"] = True
    t["FIRE"] = np.where(k % 2 == 1, True, None)  # booléen à trous (None = relâché)
    for col in ("BACK", "LEFT", "RIGHT", "JUMP", "RIGHTCLICK", "RELOAD", "USE", "INSPECT"):
        t[col] = False
    s0 = min(str(s) for s in t["steamid"].unique())
    mine = t["steamid"].astype(str) == s0
    order = t.loc[mine, "tick"].sort_values()
    t["crosshair_code"] = None
    t.loc[mine & (t["tick"] == order.iloc[0]), "crosshair_code"] = ""  # vide : ignoré
    t.loc[mine & (t["tick"] > order.iloc[0]), "crosshair_code"] = XHAIR
    t.loc[mine & (t["tick"] > order.iloc[100]), "crosshair_code"] = "CSGO-autre"  # le premier non vide est gardé
    # FOV de la caméra : 0 (défaut), 90, 40, hors plage (300), NaN, négatif — selon le tick
    t[FOV_COL] = np.select([k % 6 == 1, k % 6 == 2, k % 6 == 3, k % 6 == 4, k % 6 == 5],
                           [90.0, 40.0, 300.0, np.nan, -5.0], 0.0)
    # réglages des bras : colonnes présentes mais vides (NaN) sauf pour les joueurs 0, 1 et 2 (ordre des steamid)
    ids = sorted(str(s) for s in t["steamid"].unique())
    sid = t["steamid"].astype(str)
    span2, span3 = compute_round_spans(raw)[1:3]
    vm = {c: np.full(len(t), np.nan) for c in VM_COLS}

    def put(mask, values):
        for c, v in zip(VM_COLS, values, strict=True):
            vm[c][mask] = v

    tick = t["tick"].to_numpy()
    put((sid == ids[0]).to_numpy(), VM_A)
    # joueur 0 : B pour une ligne sur 7 et dans la dernière seconde du round 2 (le dernier réglage du round n'est pas le plus fréquent)
    put((sid == ids[0]).to_numpy() & ((k % 7 == 0) | ((tick > span2.end - 64) & (tick < span3.start))), VM_B)
    vm[VM_COLS[3]][(sid == ids[0]).to_numpy() & (k % 11 == 0)] = np.nan  # ligne incomplète : ignorée
    # joueur 1 : réglage différent avant et après le début du round 3 ; 0,1 n'est pas exact en float32
    put((sid == ids[1]).to_numpy() & (tick < span3.start), [60.0, 0.1, 1.0, -1.0])
    put((sid == ids[1]).to_numpy() & (tick >= span3.start), VM_D)
    put((sid == ids[2]).to_numpy(), [0.0, 1.0, 1.0, 1.0])  # viewmodel_fov = 0 : valeur impossible, inconnu
    for c in VM_COLS:
        t[c] = vm[c].astype(np.float32)
    return build_demo(raw), raw, s0


def test_frames_view_fields(nuke_view, nuke):
    demo, raw, s0 = nuke_view
    fr = demo.frames[2]
    f = fr.fields
    q = (fr.ticks.astype(np.int64) // 4)[:, None]  # (n, 1) : mêmes valeurs pour les 10 joueurs
    ones = np.ones((1, len(fr.players)), np.int64)
    assert f["pitch"].dtype == np.float32 and f["duck"].dtype == np.uint8 and f["zoom"].dtype == np.uint8
    assert f["clip"].dtype == f["reserve"].dtype == f["keys"].dtype == np.uint16
    assert (f["duck"] == 64).all()  # round(0,25 × 255)
    assert np.array_equal(f["clip"], np.where(q % 2 == 0, 30, NO_AMMO) * ones)
    assert np.array_equal(f["reserve"], np.where(q % 3 == 0, NO_AMMO, 2) * ones)  # chargeurs de réserve, tels quels
    assert np.array_equal(f["zoom"], np.where(q % 4 == 0, 2, 0) * ones)
    keys = (KEY_FORWARD | np.where(q % 2 == 0, KEY_DUCK, 0) | np.where(q % 3 == 0, KEY_WALK, 0)
            | np.where(q % 2 == 1, KEY_FIRE, 0))
    assert np.array_equal(f["keys"], keys * ones)
    assert np.array_equal((f["flags"] & FLAG_AIRBORNE) != 0, (q % 5 == 0) & (ones == 1))
    assert FLAG_LADDER == 128 and np.array_equal((f["flags"] & FLAG_LADDER) != 0, (q % 7 == 0) & (ones == 1))  # MoveType 9
    assert np.array_equal(f["flags"] & (0xFF ^ FLAG_AIRBORNE ^ FLAG_LADDER), nuke.frames[2].fields["flags"])  # autres bits inchangés
    j, t = fr.players.index(s0), raw.ticks
    row = t[(t["tick"] == fr.ticks[5]) & (t["steamid"].astype(str) == s0)]
    assert f["pitch"][5, j] == np.float32(row["pitch"].iloc[0])  # regard vertical gardé tel quel (degrés)
    assert fr.xhair[j] == XHAIR
    assert [x for i, x in enumerate(fr.xhair) if i != j] == [None] * 9


def test_frames_fov_u8(nuke_view):
    fr = nuke_view[0].frames[2]
    q = (fr.ticks.astype(np.int64) // 4)[:, None]
    assert fr.fields["fov"].dtype == np.uint8
    expected = np.array([0, 90, 40, 255, 0, 0])[q % 6]  # 300 borné à 255, NaN et négatif → 0
    assert np.array_equal(fr.fields["fov"], expected * np.ones((1, len(fr.players)), np.int64))


def test_frames_viewmodel_per_player(nuke_view):
    demo = nuke_view[0]
    vm = demo.frames[2].vm
    assert len(vm) == len(demo.frames[2].players) == 10
    assert vm[0] == VM_A  # la plus fréquente du round, pas la dernière (VM_B) ; ligne à NaN ignorée
    assert vm[1] == [60.0, 0.1, 1.0, -1.0]  # arrondi à 2 décimales
    assert vm[2] is None  # viewmodel_fov = 0
    assert vm[3:] == [None] * 7  # colonnes vides (NaN) : inconnu
    assert all(type(x) is float for x in vm[0] + vm[1])  # listes de float Python, prêtes pour msgpack
    assert demo.frames[3].vm[:3] == [VM_A, VM_D, None]  # une valeur par round


def test_frames_viewmodel_tie_takes_smallest():
    # égalité parfaite entre deux réglages : le plus petit (fov, x, y, z), pour un résultat déterministe
    rt = pd.DataFrame({"sid": ["a"] * 4, VM_COLS[0]: [68.0, 54.0, 68.0, 54.0], VM_COLS[1]: 1.0, VM_COLS[2]: 0.0,
                       VM_COLS[3]: -1.0})
    assert _viewmodels(rt, ["a", "b"]) == [[54.0, 1.0, 0.0, -1.0], None]


def test_frames_view_defaults_without_columns(nuke):
    # fixture d'avant la vue du joueur : seule la colonne pitch existe ; les autres champs prennent leur valeur par défaut
    fr = nuke.frames[2]
    f = fr.fields
    assert (f["duck"] == 0).all() and (f["zoom"] == 0).all() and (f["keys"] == 0).all()
    assert f["fov"].dtype == np.uint8 and (f["fov"] == 0).all()  # FOV inconnu = 0
    assert fr.vm == [None] * 10  # réglages des bras inconnus
    assert (f["clip"] == NO_AMMO).all() and (f["reserve"] == NO_AMMO).all()
    assert not (f["flags"] & (FLAG_AIRBORNE | FLAG_LADDER)).any()  # démo sans la prop : jamais le bit échelle
    assert fr.xhair == [None] * 10
    assert 1 < np.abs(f["pitch"]).max() <= 90


def test_fill_missing_positions_copies_pitch():
    # joueur absent aux images 1 et 2 (déconnecté) : position et regard de l'image 0 recopiés
    f = {k: np.zeros((3, 1), np.float32) for k in ("x", "y", "z", "yaw", "pitch")}
    f["x"][0, 0], f["y"][0, 0], f["yaw"][0, 0], f["pitch"][0, 0] = 10, 20, 90, -12.5
    _fill_missing_positions(f)
    assert f["x"][:, 0].tolist() == [10, 10, 10] and f["pitch"][:, 0].tolist() == [-12.5, -12.5, -12.5]


def test_blinds_at_32_per_second():
    # 32 images/s (une image tous les 2 ticks) : la hausse de flash_duration est vue au plus 2 ticks après l'explosion ;
    # fenêtre d'attribution = tickrate/2 + 2 = 34 ticks (36 à 16 images/s)
    raw = RawDemo(header={}, tickrate=64, sample_rate=32)
    ticks = np.arange(1000, 1100, 2, dtype=np.int32)
    fl = np.zeros((len(ticks), 2), np.float32)
    fl[10:, 1] = 3.5  # joueur « v » aveuglé à l'image 10 (tick 1020)
    fr = PRoundFrames(1, ticks, ["a", "v"], {"flash": fl}, [], [[[], []] for _ in ticks])

    def flash(detonate_tick: int) -> PGrenade:
        return PGrenade(1, 7, "flash", "a", 950, (0, 0, 0), None, None, [], detonate_tick, (0, 0, 0), detonate_tick)

    assert [(b.tick, b.attacker, b.victim) for b in build_blinds(raw, {1: fr}, [flash(986)], [])] == [(1020, "a", "v")]
    assert [b.attacker for b in build_blinds(raw, {1: fr}, [flash(985)], [])] == [None]  # 35 ticks : trop ancienne


# --------------------------------------------------------------------------- pic mémoire : colonnes et types de raw.ticks

def assert_same_frames(a: dict, b: dict) -> None:
    assert list(a) == list(b)
    for rn, x in a.items():
        y = b[rn]
        assert np.array_equal(x.ticks, y.ticks) and x.players == y.players and x.weapons == y.weapons
        assert x.inventory == y.inventory and x.xhair == y.xhair and x.vm == y.vm and x.punch == y.punch
        assert list(x.fields) == list(y.fields)
        for k, v in x.fields.items():
            assert v.dtype == y.fields[k].dtype and np.array_equal(v, y.fields[k]), k


def test_frames_same_with_the_columns_and_types_of_extract_raw(nuke_view):
    """raw.ticks comme le rend extract_raw (colonnes de TICK_PROPS seules, textes en catégories, booléens à trous en bool,
    flottants exacts en float32) donne exactement les mêmes images. La fixture mêle None, NaN, valeurs hors plage et
    un réglage qui n'est pas exact en float32 (total_ammo_left = 4294967295)."""
    demo, raw, _ = nuke_view
    keep = [c for c in raw.ticks.columns if c in TICK_PROPS or c in ("tick", "steamid")]
    assert len(keep) < len(raw.ticks.columns)  # la fixture a des colonnes en plus : nom, clan, lieu, score…
    books: dict = {}
    packed = _categorical(_compact(raw.ticks[keep], books), books)
    assert packed["active_weapon_name"].dtype == "category" and packed["crosshair_code"].dtype == "category"
    assert packed["FIRE"].dtype == bool and packed["active_weapon_ammo"].dtype == np.float32
    assert packed["total_ammo_left"].dtype == np.float64  # 4294967295 n'est pas exact en float32 : inchangé
    assert_same_frames(build_demo(dataclasses.replace(raw, ticks=packed)).frames, demo.frames)


def test_frames_same_without_unread_columns(nuke):
    """Sans les colonnes que extract_raw ne garde plus, build_frames rend la même chose que sur le tableau complet."""
    raw = load_raw(FIX / "nuke_sample")
    keep = [c for c in raw.ticks.columns if c in TICK_PROPS or c in ("tick", "steamid")]
    assert len(keep) < len(raw.ticks.columns)  # la fixture a des colonnes en plus : nom, clan, lieu, score…
    assert_same_frames(build_demo(dataclasses.replace(raw, ticks=raw.ticks[keep])).frames, nuke.frames)


def _rows(*rows) -> pd.DataFrame:
    """Lignes (tick, steamid, team_num) avec le minimum de colonnes lues par build_frames."""
    df = pd.DataFrame(rows, columns=["tick", "steamid", "team_num"])
    for c in ("X", "Y", "Z", "yaw", "flash_duration"):
        df[c] = np.float32(1.0)
    for c in ("health", "armor_value", "balance", "current_equip_value"):
        df[c] = 100
    for c in ("is_alive", "has_helmet", "has_defuser", "is_defusing", "is_scoped"):
        df[c] = True
    df["active_weapon_name"] = "weapon_ak47"
    df["inventory"] = [("AK-47",)] * len(df)
    return df


def test_frames_keep_only_valid_players_and_leave_raw_untouched():
    """Seuls les joueurs des deux équipes avec un steamid valide : pas les spectateurs (équipe 1), ni les lignes sans
    équipe (NaN), ni steamid 0."""
    ticks = _rows((0, 111, 2), (0, 222, 3), (0, 333, 1), (0, 444, np.nan), (0, 0, 2),
                  (2, 111, 2), (2, 222, 3), (2, 333, 1), (2, 444, np.nan), (2, 0, 3))
    ticks["steamid"] = ticks["steamid"].astype(np.uint64)
    raw = RawDemo(header={}, tickrate=64, sample_rate=32, ticks=ticks)
    before = ticks.copy()
    span = _RoundSpan(1, 0, 0, 10, 10 ** 9, "CT", None)
    fr = build_frames(raw, [span], BuildOptions())[1]
    assert fr.players == ["111", "222"] and fr.ticks.tolist() == [0, 2] and fr.fields["x"].shape == (2, 2)
    pd.testing.assert_frame_equal(raw.ticks, before)  # ni colonne `sid` ajoutée, ni ligne retirée
    assert build_frames(RawDemo(header={}, tickrate=64, sample_rate=32, ticks=ticks[ticks["team_num"] == 1]),
                        [span], BuildOptions()) == {}  # personne : pas de round


# --------------------------------------------------------------------------- regard à 64 images/s et recul au tir (tâche 1.10)

IMAGES = (0, 2, 4, 6, 8)  # images tous les 2 ticks (32 images/s sur une démo à 64 ticks)
YAW_A = (10.0, 20.0, 30.0, 170.0, -170.0)  # joueur « 111 » : il passe de 170 à -170 par le chemin court (180)
PITCH_A = (0.0, 5.0, 10.0, 15.0, 20.0)


def _view_raw(images=IMAGES, mids=(), fires=(), punch=(), sample_rate=32) -> RawDemo:
    """Deux joueurs (111 en équipe 2, 222 en équipe 3), images aux ticks donnés ; 111 tourne (YAW_A / PITCH_A), 222 regarde
    à 100° et -10° sans bouger. `mids` : (tick, steamid, yaw, pitch) des angles du milieu ; `fires` : (tick, steamid,
    arme) des weapon_fire ; `punch` : (tick, steamid, vertical, horizontal), et le recul de visée (vertical, horizontal)
    en plus si l'une des lignes en a (NaN pour les autres)."""
    ticks = _rows(*[(t, sid, team) for t in images for sid, team in ((111, 2), (222, 3))])
    ticks["steamid"] = ticks["steamid"].astype(np.uint64)
    idx = ticks["tick"].map({t: i for i, t in enumerate(images)}).to_numpy()
    a = (ticks["steamid"] == 111).to_numpy()
    ticks["yaw"] = np.where(a, np.array(YAW_A)[idx % 5], 100.0).astype(np.float32)
    ticks["pitch"] = np.where(a, np.array(PITCH_A)[idx % 5], -10.0).astype(np.float32)
    angles = pd.DataFrame(mids, columns=["tick", "steamid", "yaw", "pitch"]).astype(
        {"tick": np.int32, "steamid": np.uint64, "yaw": np.float32, "pitch": np.float32})
    aim = any(len(r) == 6 for r in punch)
    cols = ["tick", "steamid", "punch_pitch", "punch_yaw", *(["aim_pitch", "aim_yaw"] if aim else [])]
    rows = [(*r, *([float("nan")] * (len(cols) - len(r)))) for r in punch]
    pun = pd.DataFrame(rows, columns=cols).astype(
        {"tick": np.int32, "steamid": np.uint64, **{c: np.float32 for c in cols[2:]}})
    fire = pd.DataFrame(fires, columns=["tick", "user_steamid", "weapon"]).astype({"tick": np.int32, "user_steamid": np.uint64})
    return RawDemo(header={}, tickrate=64, sample_rate=sample_rate, ticks=ticks, angles=angles, punch=pun,
                   events={"weapon_fire": fire})


SPAN = _RoundSpan(1, 0, 0, 10, 10 ** 9, "CT", None)
# angles du milieu du joueur 111 : le premier n'est pas la moyenne de ses voisins, les 2e et 4e manquent, le 3e est de
# l'autre côté de 180 ; le joueur 222 a tous les siens
MIDS = [(1, 111, 12.0, 1.0), (5, 111, -175.0, 12.5)] + [(t, 222, 100.0, -10.0) for t in (1, 3, 5, 7)]


def test_frames_mid_sample_fields():
    """Un échantillon entre chaque paire d'images (le tick du milieu) : `yawm` et `pitchm`, comme `yaw` et `pitch` en
    float32. Un échantillon absent est remplacé par le milieu des deux images voisines (lacet par le chemin court) : le
    moteur y retrouve exactement l'interpolation linéaire d'aujourd'hui. Dernière image : sa propre valeur."""
    fr = build_frames(_view_raw(mids=MIDS), [SPAN], BuildOptions())[1]
    assert fr.players == ["111", "222"] and fr.ticks.tolist() == [0, 2, 4, 6, 8]
    ym, pm = fr.fields["yawm"], fr.fields["pitchm"]
    assert ym.dtype == pm.dtype == np.float32 and ym.shape == pm.shape == fr.fields["yaw"].shape
    # présent / absent : milieu de 20 et 30 / présent / absent : milieu de 170 et -170 par le chemin court (180) / dernière image
    assert ym[:, 0].tolist() == [12.0, 25.0, -175.0, 180.0, -170.0]
    assert pm[:, 0].tolist() == [1.0, 7.5, 12.5, 17.5, 20.0]
    assert ym[:, 1].tolist() == [100.0] * 5 and pm[:, 1].tolist() == [-10.0] * 5


def test_frames_mid_sample_leaves_the_other_fields_unchanged():
    with_mid = build_frames(_view_raw(mids=MIDS), [SPAN], BuildOptions())[1]
    without = build_frames(_view_raw(), [SPAN], BuildOptions())[1]
    assert set(with_mid.fields) - set(without.fields) == {"yawm", "pitchm"}
    for k, v in without.fields.items():
        assert with_mid.fields[k].dtype == v.dtype and np.array_equal(with_mid.fields[k], v), k
    assert np.array_equal(with_mid.ticks, without.ticks) and with_mid.inventory == without.inventory


def test_frames_mid_sample_absent_without_angles():
    """Pas de tableau d'angles (démo ancienne, fixtures, 64 images/s) : pas de champ, le moteur interpole comme avant."""
    fr = build_frames(_view_raw(), [SPAN], BuildOptions())[1]
    assert not {"yawm", "pitchm"} & set(fr.fields) and fr.punch == []
    fr64 = build_frames(_view_raw(images=range(9), sample_rate=64), [SPAN], BuildOptions())[1]
    assert not {"yawm", "pitchm"} & set(fr64.fields)  # un tick par image : rien entre deux images


def test_frames_mid_sample_needs_the_next_image_one_step_away():
    """Une image manquante (trou de 4 ticks) : l'échantillon du tick 3 n'est pas au milieu des images 2 et 6, donc écarté
    (milieu des deux voisines : lacet 20 et 30 → 25, vertical 5 et 10 → 7,5) ; ceux des ticks 1 et 7 servent."""
    mids = [(1, 111, 12.0, 1.0), (3, 111, -50.0, 99.0), (7, 111, 175.0, 17.0)]
    fr = build_frames(_view_raw(images=(0, 2, 6, 8), mids=mids), [SPAN], BuildOptions())[1]
    assert fr.ticks.tolist() == [0, 2, 6, 8] and fr.fields["yaw"][:, 0].tolist() == [10.0, 20.0, 30.0, 170.0]
    assert fr.fields["yawm"][:, 0].tolist() == [12.0, 25.0, 175.0, 170.0]
    assert fr.fields["pitchm"][:, 0].tolist() == [1.0, 7.5, 17.0, 15.0]


def test_frames_mid_sample_rounded_for_a_longer_step():
    """16 images/s : une image tous les 4 ticks, le tick du milieu est à +2 (les ticks 1 et 3 ne servent pas)."""
    mids = [(1, 111, -1.0, -1.0), (2, 111, 15.0, 2.5), (3, 111, -3.0, -3.0), (6, 111, 25.0, 7.5)]
    fr = build_frames(_view_raw(images=(0, 4, 8, 12), mids=mids, sample_rate=16), [SPAN], BuildOptions())[1]
    assert fr.fields["yaw"][:, 0].tolist() == [10.0, 20.0, 30.0, 170.0]
    assert fr.fields["yawm"][:, 0].tolist() == [15.0, 25.0, 100.0, 170.0]  # 3e image : pas d'échantillon, milieu de 30 et 170
    assert fr.fields["pitchm"][:, 0].tolist() == [2.5, 7.5, 12.5, 15.0]


def test_frames_mid_sample_ignores_other_players_and_nan():
    """Un joueur absent du round, un NaN : écartés (milieu des voisines à la place)."""
    mids = [(1, 111, float("nan"), float("nan")), (1, 999, 50.0, 50.0), (3, 111, 22.0, 6.0)]
    fr = build_frames(_view_raw(mids=mids), [SPAN], BuildOptions())[1]
    assert fr.fields["yawm"][:2, 0].tolist() == [15.0, 22.0] and fr.fields["pitchm"][:2, 0].tolist() == [2.5, 6.0]
    assert fr.players == ["111", "222"]


FIRES = [(1, 111, "weapon_ak47"), (1, 111, "weapon_ak47"),  # le même tir deux fois : gardé une fois
         (5, 222, "weapon_glock"), (5, 111, "weapon_knife"), (7, 111, "weapon_smokegrenade"), (3, 111, "weapon_hegrenade"),
         (3, 999, "weapon_ak47"),  # tireur absent du round
         (9, 111, "weapon_ak47"),  # pas de lecture du recul pour ce tir
         (400, 111, "weapon_ak47")]  # après la fin des images (tick 330 : fin du round + 5 s)
PUNCH = [(1, 111, -1.099, -0.568), (5, 222, -2.0, 0.25), (5, 111, -9.0, 9.0), (7, 111, -9.0, 9.0), (3, 111, -9.0, 9.0),
         (3, 999, -9.0, 9.0), (400, 111, -3.0, 0.5)]


def test_frames_shots_with_punch():
    """Tirs du round : [tick, indice du joueur, vertical, horizontal] en degrés (3 décimales), par ordre de tick. Seules
    les armes à feu comptent (pas le couteau ni les grenades, comme build_shots), seuls les joueurs du round, et seuls
    les tirs dont on a lu le recul ; le même tir lu deux fois n'est gardé qu'une fois."""
    fr = build_frames(_view_raw(fires=FIRES, punch=PUNCH), [SPAN], BuildOptions())[1]
    assert fr.players == ["111", "222"]
    assert fr.punch == [[1, 0, -1.099, -0.568], [5, 1, -2.0, 0.25]]
    assert all(type(x[0]) is int and type(x[1]) is int and type(x[2]) is float and type(x[3]) is float for x in fr.punch)


def test_frames_shots_with_aim_punch():
    """Recul de visée lu au tir : deux valeurs de plus, [tick, joueur, vertical, horizontal, visée verticale, visée
    horizontale] (3 décimales) ; tir sans recul de visée (NaN) : les 4 valeurs d'avant."""
    punch = [(1, 111, -1.099, -0.568, 0.0, 0.0), (5, 222, -2.0, 0.25, -0.62449, 0.0012), (9, 111, -1.5, 0.1)]
    fires = [(1, 111, "weapon_ak47"), (5, 222, "weapon_glock"), (9, 111, "weapon_ak47")]
    fr = build_frames(_view_raw(fires=fires, punch=punch), [SPAN], BuildOptions())[1]
    assert fr.punch == [[1, 0, -1.099, -0.568, 0.0, 0.0], [5, 1, -2.0, 0.25, -0.624, 0.001], [9, 0, -1.5, 0.1]]
    assert all(type(v) is float for x in fr.punch for v in x[2:])


def test_frames_shots_belong_to_their_round():
    raw = _view_raw(images=(0, 2, 4, 6, 8, 20, 22), fires=[(1, 111, "weapon_ak47"), (21, 111, "weapon_ak47")],
                    punch=[(1, 111, -1.0, 0.5), (21, 111, -2.0, -0.5)])
    one = _RoundSpan(1, 0, 0, 10, 20, "CT", None)
    two = _RoundSpan(2, 20, 20, 30, 10 ** 9, "T", None)
    frames = build_frames(raw, [one, two], BuildOptions())
    assert frames[1].punch == [[1, 0, -1.0, 0.5]] and frames[2].punch == [[21, 0, -2.0, -0.5]]


def test_frames_shots_empty_without_punch_or_fire_events():
    assert build_frames(_view_raw(fires=FIRES), [SPAN], BuildOptions())[1].punch == []  # recul non lu (démo ancienne)
    assert build_frames(_view_raw(punch=PUNCH), [SPAN], BuildOptions())[1].punch == []  # aucun événement de tir


def test_old_fixture_frames_have_no_mid_fields_and_no_shots(nuke, faceit):
    """Fixtures d'avant la tâche (ni angles du milieu, ni recul) : images inchangées, rien de plus."""
    for demo in (nuke, faceit):
        for fr in demo.frames.values():
            assert not {"yawm", "pitchm"} & set(fr.fields) and fr.punch == []


# --------------------------------------------------------------------------- réserve de munitions en chargeurs

R1 = _RoundSpan(1, 0, 0, 1000, 1000, "CT", None)
R2 = _RoundSpan(2, 1000, 1000, 2000, 10 ** 9, "T", None)
U = NO_AMMO


def _ammo_rows(*rows) -> pd.DataFrame:
    """Lignes (tick, joueur, arme, chargeur, réserve) : seules les colonnes lues par _reserve_mags, dans l'ordre donné."""
    df = pd.DataFrame(rows, columns=["tick", "sid", "active_weapon_name", "active_weapon_ammo", "total_ammo_left"])
    df["tick"] = df["tick"].astype(np.int64)
    return df


def _mags(rows, spans=(R1, R2)) -> list[int]:
    return _reserve_mags(_ammo_rows(*rows), list(spans), 0).tolist()


def test_reserve_leading_zeros_take_the_first_value_plus_the_reload_in_mags():
    """Démo déjà en chargeurs : l'AK de départ est à 0 (jamais mise à jour) jusqu'à la fin du premier rechargement, qui la
    met à 2 (90 - 18 = 72 balles, deux chargeurs entiers). Avant, la réserve était pleine : 2 + 1 = 3 chargeurs, y compris
    après des tirs sans rechargement. Un 0 après une valeur non nulle est un vrai 0."""
    rows = [(0, "a", "AK-47", 30, 0), (2, "a", "AK-47", 25, 0), (4, "a", "AK-47", 12, 0),  # tirs, aucune mise à jour
            (6, "a", "AK-47", 30, 2),                                                         # fin du rechargement
            (8, "a", "AK-47", 12, 2), (10, "a", "AK-47", 30, 0)]                              # un vrai 0 ensuite (rechargement)
    assert _mags(rows) == [3, 3, 3, 2, 2, 0]


def test_reserve_first_value_without_reload_is_taken_as_is():
    """Première valeur non nulle sans hausse du chargeur (remplissage de début de round) : reprise telle quelle, pas de +1."""
    rows = [(0, "a", "AK-47", 30, 0), (2, "a", "AK-47", 30, 0), (4, "a", "AK-47", 30, 3), (6, "a", "AK-47", 30, 3)]
    assert _mags(rows) == [3, 3, 3, 3]


def test_reserve_unknown_stays_unknown_and_is_not_filled():
    """NaN et 4294967295 (-1 relu en uint32) restent inconnus, même avant la première valeur ; seuls les 0 de tête sont remplis."""
    rows = [(0, "a", "AK-47", 30, np.nan), (2, "a", "AK-47", 30, 4294967295.0), (4, "a", "AK-47", 30, 0),
            (6, "a", "AK-47", 30, 3)]
    assert _mags(rows) == [U, U, 3, 3]


def test_reserve_weapon_switch_keeps_the_period_within_the_round():
    """Passer au couteau et revenir à l'AK ne change pas sa réserve : même arme, même round, même période. Le couteau
    (pas de chargeur) garde sa valeur brute."""
    rows = [(0, "a", "AK-47", 30, 0), (2, "a", "Knife", 0, 1), (4, "a", "AK-47", 30, 0), (6, "a", "AK-47", 12, 0),
            (8, "a", "AK-47", 30, 2)]
    assert _mags(rows) == [3, 1, 3, 3, 2]


def test_reserve_another_weapon_of_the_same_name_starts_a_new_period():
    """Une AK à 3 qui devient une AK à 0 sans hausse du chargeur n'est pas une réserve vidée (une réserve ne baisse qu'à la
    fin d'un rechargement) : c'est une autre AK, ramassée dans le round. Ses 0 de tête sont faux, comme pour la première.
    Une baisse avec hausse du chargeur (rechargement) reste la même arme."""
    swap = [(0, "a", "AK-47", 30, 3), (2, "a", "AK-47", 30, 3), (4, "a", "AK-47", 30, 0), (6, "a", "AK-47", 25, 0),
            (8, "a", "AK-47", 30, 2)]
    assert _mags(swap) == [3, 3, 3, 3, 2]
    reload = [(0, "a", "AK-47", 30, 3), (2, "a", "AK-47", 12, 3), (4, "a", "AK-47", 30, 2), (6, "a", "AK-47", 8, 2),
              (8, "a", "AK-47", 30, 0)]
    assert _mags(reload) == [3, 3, 2, 2, 0]  # 2 → 0 avec hausse du chargeur : vrai 0, pas de nouvelle période


def test_reserve_each_round_and_each_player_has_its_own_period():
    """Les périodes ne se mélangent ni d'un round à l'autre ni d'un joueur à l'autre : chacune est remplie par sa propre
    première valeur."""
    rows = [(0, "a", "AK-47", 30, 0), (2, "a", "AK-47", 30, 3),            # round 1, joueur a : 3
            (4, "b", "AK-47", 30, 0), (6, "b", "AK-47", 30, 1),            # round 1, joueur b : 1
            (1000, "a", "AK-47", 30, 0), (1002, "a", "AK-47", 30, 2)]      # round 2, joueur a : 2
    assert _mags(rows) == [3, 3, 1, 1, 2, 2]


def test_reserve_period_without_any_value_takes_the_full_reserve_of_the_weapon_in_the_demo():
    """Une AK jamais mise à jour pendant tout un round (le cas du tick 12684 : l'AK de NertZ est à 0 du round 2 à son premier
    rechargement, au round 4) : la réserve était pleine, donc celle que la démo montre pour cette arme à pleine réserve
    (ici 3 : une AK qui passe à 2 chargeurs au rechargement avait 3 chargeurs avant). Une arme dont la démo ne donne jamais
    de valeur non nulle reste inconnue (jamais 0)."""
    rows = [(0, "a", "AK-47", 30, 0), (2, "a", "AK-47", 25, 0), (4, "a", "Desert Eagle", 7, 0),
            (1000, "b", "AK-47", 12, 0), (1002, "b", "AK-47", 30, 2),
            (1004, "b", "Desert Eagle", 7, 0)]
    assert _mags(rows) == [3, 3, U, 3, 2, U]


def test_reserve_in_bullets_is_converted_to_mags_by_the_biggest_clip_seen():
    """Démo en balles : chargeurs pleins = plancher(réserve / plus grand chargeur vu pour ce nom d'arme), comme le jeu récent
    (72 balles d'AK : 2), mais au moins 1 tant que la réserve n'est pas vide (un chargeur entamé reste affiché).
    AK 90 → 3, 72 → 2, 61 → 2, 60 → 2, 30 → 1, 1 → 1 ; AWP (chargeur de 5) 30 → 6 ; 0 après une valeur : 0."""
    rows = [(0, "a", "AK-47", 30, 90), (2, "a", "AK-47", 30, 72), (4, "a", "AK-47", 30, 61), (6, "a", "AK-47", 30, 60),
            (8, "a", "AK-47", 30, 30), (10, "a", "AK-47", 12, 1), (12, "a", "AK-47", 30, 0),
            (14, "b", "AWP", 5, 30), (16, "b", "AWP", 3, 30)]
    assert _mags(rows) == [3, 2, 2, 2, 1, 1, 0, 6, 6]


def test_reserve_in_bullets_leading_zeros_get_the_balls_the_reload_consumed():
    """Démo en balles : première valeur 72 à la fin d'un rechargement de 18 balles (12 → 30) : 72 + 18 = 90 avant, donc
    3 chargeurs, puis 72 → 2. Sans hausse du chargeur : la valeur brute (60 → 2 chargeurs)."""
    reload_end = [(0, "a", "AK-47", 30, 0), (2, "a", "AK-47", 12, 0), (4, "a", "AK-47", 30, 72), (6, "a", "AK-47", 30, 72)]
    refill = [(1000, "b", "AK-47", 30, 0), (1002, "b", "AK-47", 30, 60)]
    assert _mags(reload_end + refill) == [3, 3, 2, 2, 2, 2]


def test_reserve_unit_is_decided_for_the_whole_demo():
    """Des valeurs en balles sur l'essentiel des armes décident que toute la démo l'est, y compris pour une arme dont les
    valeurs sont petites (et la grenade, sans chargeur, n'en décide pas : sa valeur brute 1 reste 1)."""
    rows = [(0, "a", "Smoke Grenade", 0, 1), (2, "a", "AK-47", 30, 2)] + [(4 + 2 * i, "b", "USP-S", 12, 24) for i in range(3)]
    assert _mags(rows) == [1, 1, 2, 2, 2]  # 2 balles → 1 chargeur entamé ; 24 balles → 2 chargeurs de 12
    assert _mags(rows[:2]) == [1, 2]  # aucune valeur > 12 : déjà en chargeurs


def test_reserve_unknown_without_the_columns():
    rows = _ammo_rows((0, "a", "AK-47", 30, 3))
    assert _reserve_mags(rows.drop(columns="total_ammo_left"), [R1], 0).tolist() == [U]
    # sans nom d'arme ni chargeur : valeur brute, comme avant
    assert _reserve_mags(rows.drop(columns=["active_weapon_name", "active_weapon_ammo"]), [R1], 0).tolist() == [3]


def test_reserve_rows_outside_the_rounds_keep_their_raw_value():
    """Avant le premier round et entre deux rounds : pas de période, valeur brute."""
    r = _RoundSpan(1, 100, 100, 200, 300, "CT", None)
    rows = [(0, "a", "AK-47", 30, 0), (150, "a", "AK-47", 12, 0), (152, "a", "AK-47", 30, 2)]
    assert _reserve_mags(_ammo_rows(*rows), [r], 0).tolist() == [0, 3, 2]


def test_reserve_unit_ignores_isolated_values_above_the_limit():
    """Une valeur isolée au-dessus de 12 (une ligne Zeus à 90) ne bascule pas toute la démo en balles : il faut au moins 3
    lignes ET 1 % des valeurs non nulles d'armes à chargeur."""
    rows = [(0, "a", "AK-47", 30, 3), (2, "a", "AK-47", 30, 3), (4, "a", "Zeus x27", 1, 90)]
    assert _mags(rows) == [3, 3, 90]  # reste en chargeurs : 3 et 3 tels quels
    many = [(2 * i, "a", "AK-47", 30, 3) for i in range(1000)] + [(2000 + 2 * i, "a", "Zeus x27", 1, 90) for i in range(5)]
    assert _mags(many, (R1, R2))[:2] == [3, 3] and _mags(many, (R1, R2))[-1] == 90  # 5 lignes sur 1005 : moins de 1 %
    few = [(0, "a", "AK-47", 30, 3), (2, "a", "AK-47", 30, 3)] + [(4 + 2 * i, "a", "AK-47", 30, 90) for i in range(3)]
    assert _mags(few) == [1, 1, 3, 3, 3]  # 3 lignes sur 5 : en balles (90 → 3 chargeurs, 3 balles → 1 chargeur entamé)


def test_reserve_unit_filters_the_sentinels_of_the_clip():
    """Un chargeur illisible (65535, négatif) sur une arme à feu ne gonfle pas le plus grand chargeur du nom d'arme."""
    rows = [(2 * i, "a", "AK-47", 30, 90) for i in range(5)] + [(10, "a", "AK-47", 65535, 90), (12, "a", "AK-47", -1, 90)]
    assert _mags(rows) == [3] * 7


def test_reserve_does_not_crash_without_any_weapon_name():
    """Aucun nom d'arme renseigné (None, NaN ou catégorie vide) : pas d'arme à chargeur, valeurs brutes inchangées."""
    rows = _ammo_rows((0, "a", "AK-47", 30, 0), (2, "a", "AK-47", 30, 3), (4, "a", "AK-47", 30, np.nan))
    for names in (None, np.nan, pd.Series([None] * 3, dtype="category")):
        df = rows.copy()
        df["active_weapon_name"] = names
        assert _reserve_mags(df, [R1], 0).tolist() == [0, 3, U], names


def test_reserve_with_categorical_weapon_names_like_in_production():
    """extract.py garde les noms d'armes en catégories (CATEGORY_COLUMNS) : même résultat qu'avec des textes, y compris pour une
    catégorie jamais utilisée et un nom manquant."""
    rows = [(0, "a", "AK-47", 30, 0), (2, "a", "AK-47", 12, 0), (4, "a", "AK-47", 30, 2), (6, "a", None, 0, 1),
            (8, "b", "Desert Eagle", 7, 0), (10, "a", "AK-47", 30, 2)]
    df = _ammo_rows(*rows)
    expected = _reserve_mags(df, [R1, R2], 0).tolist()
    assert expected == [3, 3, 2, 1, U, 2]  # sans nom d'arme : valeur brute (1) ; Deagle jamais non nul : inconnu
    cat = df.assign(active_weapon_name=pd.Categorical(df["active_weapon_name"], categories=["Knife", "Desert Eagle", "AK-47", "AWP"]))
    assert cat["active_weapon_name"].dtype == "category"
    assert _reserve_mags(cat, [R1, R2], 0).tolist() == expected
    bullets = _ammo_rows(*[(2 * i, "a", "AK-47", 30, 90) for i in range(4)] + [(10, "a", "AK-47", 30, 72)])
    as_cat = bullets.assign(active_weapon_name=bullets["active_weapon_name"].astype("category"))
    assert _reserve_mags(as_cat, [R1], 0).tolist() == _reserve_mags(bullets, [R1], 0).tolist() == [3, 3, 3, 3, 2]


def test_frames_reserve_in_bullets_and_mags_end_to_end():
    """build_frames : le champ `reserve` d'une démo en balles est en chargeurs, la même démo déjà en chargeurs est inchangée."""
    def with_ammo(clip, reserve):
        raw = _view_raw()
        t = raw.ticks
        t["active_weapon_name"] = "AK-47"
        t["active_weapon_ammo"] = clip(t)
        t["total_ammo_left"] = reserve(t)  # à 0 jusqu'à la première mise à jour, au tick 4
        return build_frames(raw, [SPAN], BuildOptions())[1].fields["reserve"]

    mags = with_ammo(lambda t: 30.0, lambda t: np.where(t["tick"] < 4, 0.0, 2.0))
    assert mags.tolist() == [[2, 2]] * 5  # première valeur sans rechargement : reprise telle quelle pour les 0 de tête
    # la même AK en balles : 50 balles au tick 4 ; le joueur 111 a rechargé (12 → 30) alors que 222 était déjà plein
    bullets = with_ammo(lambda t: np.where((t["steamid"] == 111) & (t["tick"] < 4), 12.0, 30.0),
                        lambda t: np.where(t["tick"] < 4, 0.0, 50.0))
    assert bullets[:, 0].tolist() == [2, 2, 1, 1, 1]  # 111 : 50 + 18 = 68 balles avant (2 chargeurs), 50 après (1)
    assert bullets[:, 1].tolist() == [1, 1, 1, 1, 1]  # 222 : pas de rechargement, 50 balles → 1 chargeur entier


def test_frames_reserve_falls_back_to_the_raw_column_when_the_correction_fails(monkeypatch, caplog):
    """Une exception inattendue dans _reserve_mags (démo jamais vue) ne fait pas échouer l'analyse : la réserve reprend la
    colonne brute (comme avant la correction : 0 de tête et unité de la démo gardés), avec un avertissement au journal ;
    les autres champs ne changent pas. Sans la colonne : inconnue (NO_AMMO)."""
    from app.parsing import build

    def raw_ammo(drop_reserve=False):
        raw = _view_raw()
        t = raw.ticks
        t["active_weapon_name"] = "AK-47"
        t["active_weapon_ammo"] = 30.0
        t["total_ammo_left"] = np.where(t["tick"] < 4, 0.0, 2.0)
        if drop_reserve:
            raw.ticks = t.drop(columns="total_ammo_left")
        return raw

    good = build_frames(raw_ammo(), [SPAN], BuildOptions())[1]

    def boom(*_args):
        raise ValueError("forme inattendue")

    monkeypatch.setattr(build, "_reserve_mags", boom)
    with caplog.at_level("WARNING", logger="app.parsing.build"):
        fr = build_frames(raw_ammo(), [SPAN], BuildOptions())[1]
    assert fr.fields["reserve"].dtype == np.uint16
    assert fr.fields["reserve"].tolist() == [[0, 0], [0, 0], [2, 2], [2, 2], [2, 2]]  # colonne brute, 0 de tête compris
    assert set(fr.fields) == set(good.fields)
    for k, v in good.fields.items():
        if k != "reserve":
            assert np.array_equal(fr.fields[k], v), k
    warned = [r for r in caplog.records if r.levelname == "WARNING" and "Réserve en chargeurs" in r.getMessage()]
    assert len(warned) == 1 and warned[0].exc_info is not None
    no_col = build_frames(raw_ammo(drop_reserve=True), [SPAN], BuildOptions())[1]
    assert no_col.fields["reserve"].tolist() == [[NO_AMMO, NO_AMMO]] * 5


def test_build_frames_fills_agents_in_players_order():
    """build_frames remplit PRoundFrames.agents dans l'ordre de `players` : agent équipé de 111, agent par défaut de 222 → None."""
    raw = _view_raw()
    skins = np.where(raw.ticks["steamid"] == 111, "customplayer_tm_leet_variantf", "customplayer_ct_map_based")
    raw.ticks["agent_skin"] = pd.Categorical(skins)  # catégorie, comme extract_raw
    fr = build_frames(raw, [SPAN], BuildOptions())[1]
    assert fr.players == ["111", "222"]
    assert fr.agents == ["tm_leet_variantf", None]
    assert fr.agents[fr.players.index("111")] == "tm_leet_variantf"
    # colonne absente (ancienne extraction) : aucun agent, pour chaque joueur
    assert build_frames(_view_raw(), [SPAN], BuildOptions())[1].agents == [None, None]


def test_frames_agents_per_player():
    # agent le plus fréquent du joueur ; agent par défaut, vide ou colonne absente → None ; catégories comme en production
    skins = ["customplayer_tm_leet_variantf"] * 2 + ["customplayer_tm_phoenix", "customplayer_t_map_based", None]
    rt = pd.DataFrame({"sid": ["a", "a", "a", "b", "c"], "agent_skin": pd.Categorical(skins)})
    assert _agents(rt, ["a", "b", "c", "d"]) == ["tm_leet_variantf", None, None, None]
    assert _agents(rt.drop(columns="agent_skin"), ["a"]) == [None]


def test_round_forces_per_victim():
    """Force de la mort lue à l'analyse : une ligne par (tick, victime), rangée par round avec l'indice du joueur, arrondie
    au dixième (-0 ramené à 0) ; victime absente du round, mort hors du round ou force illisible (NaN) écartées ; sans
    tableau (extraction d'avant le ragdoll) : rien."""
    a, b, x = 76561198000000001, 76561198000000002, 76561198000000009
    forces = pd.DataFrame({"tick": [300, 150, 150, 900, 160], "steamid": [b, a, a, a, x],
                           "fx": np.array([1.26, 24000, 24000, 5, 7], np.float32),
                           "fy": np.array([-0.04, 0, 0, 5, 7], np.float32),
                           "fz": np.array([3, -7, -7, np.nan, 7], np.float32)})
    got = _death_forces(RawDemo(header={}, tickrate=64, sample_rate=32, forces=forces))
    pi = {str(a): 0, str(b): 1}
    assert _round_forces(got, pi, 100, 400) == [[150, 0, 24000.0, 0.0, -7.0], [300, 1, 1.3, 0.0, 3.0]]
    assert _round_forces(got, pi, 400, 1000) == []  # 900 : force illisible
    assert _round_forces(_death_forces(RawDemo(header={}, tickrate=64, sample_rate=32)), pi, 0, 10 ** 9) == []


def test_build_frames_fills_forces(nuke):
    """build_frames range la force de la démo dans les images de son round ; fixture d'avant le ragdoll (sans
    forces.parquet) : [] dans chaque round."""
    assert all(fr.forces == [] for fr in nuke.frames.values())
    first = min(nuke.frames)
    fr1 = nuke.frames[first]
    tick, sid = int(fr1.ticks[5]), fr1.players[3]
    raw = load_raw(FIX / "nuke_sample")
    raw.forces = pd.DataFrame({"tick": [tick], "steamid": [int(sid)], "fx": np.array([24000], np.float32),
                               "fy": np.array([-1.5], np.float32), "fz": np.array([300], np.float32)})
    assert build_demo(raw).frames[first].forces == [[tick, 3, 24000.0, -1.5, 300.0]]
