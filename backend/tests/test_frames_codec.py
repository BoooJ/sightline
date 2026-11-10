# backend/tests/test_frames_codec.py
import dataclasses
from pathlib import Path

import numpy as np
import pytest

from app.parsing.build import build_demo
from app.parsing.extract import load_raw
from app.parsing.model import PRoundFrames
from app.storage.frames_codec import _QUANT, WIRE_VERSION, _from, decode_frames, encode_frames, frames_wire, pack, unpack

XHAIR = "CSGO-G2Zz6-mGBLn-MHzzc-RYnkA-vZ9GJ"
VM = [68.0, 2.5, 0.0, -1.5]  # [viewmodel_fov, offset x, y, z]
VIEW_FIELDS = ("pitch", "duck", "clip", "reserve", "zoom", "keys", "fov")


@pytest.fixture(scope="module")
def frames():
    return build_demo(load_raw(Path(__file__).parent / "fixtures" / "nuke_sample")).frames[2]


def test_roundtrip(frames):
    blob = encode_frames(frames)
    back = decode_frames(blob)
    assert back.players == frames.players and back.weapons == frames.weapons
    assert np.array_equal(back.ticks, frames.ticks)
    for k, v in frames.fields.items():
        assert back.fields[k].dtype == v.dtype and np.array_equal(back.fields[k], v), k
    assert back.inventory == frames.inventory
    assert back.xhair == frames.xhair == [None] * 10
    assert back.vm == frames.vm == [None] * 10


def test_size_and_wire(frames):
    blob = encode_frames(frames)
    assert len(blob) < 600_000
    w = frames_wire(blob)
    assert w["v"] == 2 and w["m"] == 10 and w["n"] == len(frames.ticks)
    assert w["fields"]["x"]["enc"] == "dpm" and w["inv_offsets"]["enc"] == "d"
    assert _QUANT == {"x": 4, "y": 4, "z": 4, "yaw": 100, "pitch": 100, "yawm": 100, "pitchm": 100}
    assert w["fields"]["pitch"]["enc"] == "dpm" and w["fields"]["pitch"]["dtype"] == "<i2"  # |Δ| ≤ 180° → int16
    for k, dt in (("duck", "|u1"), ("clip", "<u2"), ("reserve", "<u2"), ("zoom", "|u1"), ("keys", "<u2"), ("fov", "|u1")):
        assert w["fields"][k]["dtype"] == dt and "enc" not in w["fields"][k], k  # transmis bruts


def test_wire_roundtrip(frames):
    # reproduit le décodage du client (engine/wire.ts) et vérifie la précision de la quantification
    w = frames_wire(encode_frames(frames))
    n, m = w["n"], w["m"]
    for k in ("x", "y", "z", "yaw", "pitch"):
        f = w["fields"][k]
        d = np.frombuffer(f["data"], np.dtype(f["dtype"])).reshape(m, n)
        back = (np.cumsum(d.astype(np.int64), axis=1).T / f["scale"]).astype(np.float32)
        assert np.abs(back - frames.fields[k]).max() <= 0.5 / f["scale"] + 1e-3, k
    off = np.cumsum(np.frombuffer(w["inv_offsets"]["data"], np.dtype(w["inv_offsets"]["dtype"])))
    assert off[0] == 0 and off[-1] == sum(len(x) for row in frames.inventory for x in row)
    assert len(off) == n * m + 1


def test_xhair_stored_and_sent(frames):
    fr = dataclasses.replace(frames, xhair=[XHAIR] + [None] * 9)
    blob = encode_frames(fr)
    assert decode_frames(blob).xhair == fr.xhair
    assert frames_wire(blob)["xhair"] == fr.xhair  # transmis tel quel au navigateur


def test_fov_roundtrip(frames):
    # le FOV par image est un champ u8 comme zoom : stocké et transmis tel quel
    fov = np.zeros_like(frames.fields["fov"])
    fov[::3, 0], fov[1::3, 1], fov[2, 2] = 90, 40, 10
    fr = dataclasses.replace(frames, fields={**frames.fields, "fov": fov})
    blob = encode_frames(fr)
    back = decode_frames(blob).fields["fov"]
    assert back.dtype == np.uint8 and np.array_equal(back, fov)
    w = frames_wire(blob)["fields"]["fov"]
    assert w["dtype"] == "|u1" and "enc" not in w
    assert np.array_equal(np.frombuffer(w["data"], np.uint8).reshape(fov.shape), fov)


def test_vm_stored_and_sent(frames):
    fr = dataclasses.replace(frames, vm=[VM, None] + [[60.0, 0.1, 1.0, -1.0]] + [None] * 7)
    blob = encode_frames(fr)
    assert decode_frames(blob).vm == fr.vm  # 2 décimales conservées à l'identique
    assert frames_wire(blob)["vm"] == fr.vm  # transmis tel quel au navigateur


def test_blob_without_fov_and_vm(frames):
    # blob d'une version 3 intermédiaire (réticule et touches, mais ni FOV ni réglages des bras) : relu comme avant
    w = unpack(encode_frames(frames))
    del w["fields"]["fov"], w["vm"]
    old = pack(w)
    back = decode_frames(old)
    assert back.vm == [] and "fov" not in back.fields and "zoom" in back.fields
    wire = frames_wire(old)
    assert "vm" not in wire and "fov" not in wire["fields"] and "zoom" in wire["fields"]


def test_old_blob_without_view_fields(frames):
    # blob écrit avant PARSER_VERSION 3 : ni pitch, duck… ni xhair ; il se relit et se transmet comme avant
    w = unpack(encode_frames(frames))
    for k in VIEW_FIELDS:
        del w["fields"][k]
    del w["xhair"], w["vm"]
    old = pack(w)
    back = decode_frames(old)
    assert back.xhair == [] and back.vm == [] and not set(VIEW_FIELDS) & set(back.fields)
    assert np.array_equal(back.fields["x"], frames.fields["x"])
    wire = frames_wire(old)
    assert wire["v"] == WIRE_VERSION == 2 and not {"xhair", "vm"} & set(wire) and not set(VIEW_FIELDS) & set(wire["fields"])
    assert wire["fields"]["yaw"]["enc"] == "dpm"


def test_pack_unpack():
    obj = [[1, 2.5, 3.0, 4.0], [2, 1.0, 1.0, 1.0]]
    assert unpack(pack(obj)) == obj


def test_concurrent_unpack(frames):
    # FastAPI sert les routes synchrones dans un pool de threads : deux replays décodés en même temps
    # (round affiché + préchargement du suivant) ne doivent pas se corrompre mutuellement.
    from concurrent.futures import ThreadPoolExecutor

    blob = encode_frames(frames)
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(lambda _: frames_wire(blob)["n"], range(200)))
    assert results == [len(frames.ticks)] * 200


# [tick, indice du joueur, vertical, horizontal] en degrés, plus le recul de visée (vertical, horizontal) s'il a été lu
PUNCH = [[1000, 0, -1.099, -0.568, 0.0, 0.0], [1004, 4, -2.0, 0.25], [1006, 0, -1.357, 0.248, -0.098, -0.051]]


def _with_mid_and_punch(frames):
    f = frames.fields
    return dataclasses.replace(frames, punch=PUNCH, fields={**f, "yawm": (f["yaw"] + np.float32(0.4)).astype(np.float32),
                                                            "pitchm": (f["pitch"] * np.float32(0.5)).astype(np.float32)})


def test_mid_angles_and_punch_roundtrip(frames):
    fr = _with_mid_and_punch(frames)
    back = decode_frames(encode_frames(fr))
    assert back.punch == fr.punch
    for k in ("yawm", "pitchm"):
        assert back.fields[k].dtype == np.float32 and np.array_equal(back.fields[k], fr.fields[k]), k


def test_mid_angles_quantised_like_yaw_and_pitch(frames):
    fr = _with_mid_and_punch(frames)
    w = frames_wire(encode_frames(fr))
    assert _QUANT["yawm"] == _QUANT["yaw"] == 100 and _QUANT["pitchm"] == _QUANT["pitch"] == 100
    n, m = w["n"], w["m"]
    for k in ("yawm", "pitchm"):
        f = w["fields"][k]
        assert f["enc"] == "dpm" and f["scale"] == 100 and f["dtype"] in ("<i2", "<i4")
        d = np.frombuffer(f["data"], np.dtype(f["dtype"])).reshape(m, n)
        back = (np.cumsum(d.astype(np.int64), axis=1).T / f["scale"]).astype(np.float32)
        assert np.abs(back - fr.fields[k]).max() <= 0.5 / f["scale"] + 1e-3, k  # même précision que yaw et pitch
    assert w["punch"] == PUNCH  # liste des tirs transmise telle quelle au navigateur


def test_blob_without_mid_angles_and_punch(frames):
    """Blob écrit avant la tâche (pas de punch, pas d'angles du milieu) : relu et transmis comme avant."""
    w = unpack(encode_frames(frames))
    del w["punch"]
    old = pack(w)
    back = decode_frames(old)
    assert back.punch == [] and not {"yawm", "pitchm"} & set(back.fields)
    assert np.array_equal(back.fields["pitch"], frames.fields["pitch"])
    wire = frames_wire(old)
    assert "punch" not in wire and not {"yawm", "pitchm"} & set(wire["fields"]) and wire["fields"]["pitch"]["enc"] == "dpm"
    assert wire["v"] == WIRE_VERSION == 2


def test_new_blob_without_any_shot_has_an_empty_list(frames):
    assert decode_frames(encode_frames(frames)).punch == [] and frames_wire(encode_frames(frames))["punch"] == []


def test_agents_stored_and_sent(frames):
    fr = dataclasses.replace(frames, agents=["tm_leet_variantf"] + [None] * 9)
    blob = encode_frames(fr)
    assert decode_frames(blob).agents == fr.agents
    assert frames_wire(blob)["agents"] == fr.agents  # transmis tel quel au navigateur
    w = unpack(blob)
    del w["agents"]
    assert decode_frames(pack(w)).agents == []  # blob d'avant la lecture de l'agent : relu comme avant


def test_forces_stored_and_sent(frames):
    fr = dataclasses.replace(frames, forces=[[150, 0, 24000.0, -1.5, 300.0], [190, 3, 8336.2, 10.0, 4.0]])
    blob = encode_frames(fr)
    assert decode_frames(blob).forces == fr.forces
    assert frames_wire(blob)["forces"] == fr.forces  # transmis tel quel au navigateur
    w = unpack(blob)
    del w["forces"]
    assert decode_frames(pack(w)).forces == []  # blob d'avant la lecture de la force : relu comme avant


def _decode_frames_9ea782f(blob: bytes) -> PRoundFrames:
    """Copie figée de decode_frames de l'image en ligne avant ce plan (commit 9ea782f) : ce que relit l'image d'avant
    après un retour arrière (procédure R)."""
    w = unpack(blob)
    n, m = w["n"], w["m"]
    offsets, items = _from(w["inv_offsets"]), _from(w["inv_items"]).tolist()
    inv = [[items[offsets[i * m + j]:offsets[i * m + j + 1]] for j in range(m)] for i in range(n)]
    return PRoundFrames(
        round_number=w["round"], ticks=_from(w["ticks"]), players=w["players"],
        fields={k: _from(v, (n, m)) for k, v in w["fields"].items()},
        weapons=w["weapons"], inventory=inv, xhair=list(w.get("xhair") or []), vm=list(w.get("vm") or []),
        punch=[list(r) for r in w.get("punch") or []], agents=list(w.get("agents") or []),
    )


def test_image_before_this_plan_reads_a_blob_with_forces(frames):
    """Retour arrière : l'image d'avant relit la même base. Son décodeur ne lit que les clés qu'il connaît (copie figée
    ci-dessus) : un blob écrit avec `forces` lui donne exactement les mêmes images qu'un blob sans."""
    old = _decode_frames_9ea782f(encode_frames(dataclasses.replace(frames, forces=[[150, 0, 24000.0, -1.5, 300.0]])))
    ref = _decode_frames_9ea782f(encode_frames(dataclasses.replace(frames, forces=[])))
    assert old.forces == [] and old.agents == ref.agents and old.punch == ref.punch and old.inventory == ref.inventory
    assert list(old.ticks) == list(ref.ticks) and set(old.fields) == set(ref.fields)
    assert all(np.array_equal(old.fields[k], ref.fields[k]) for k in ref.fields)
