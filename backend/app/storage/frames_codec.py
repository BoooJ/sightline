# backend/app/storage/frames_codec.py
from __future__ import annotations

import itertools
import threading
import zlib
from collections import OrderedDict
from dataclasses import dataclass, field

import msgpack
import numpy as np
import zstandard as zstd

from app.parsing.model import PRoundFrames

CODEC_VERSION = 1
# Les (dé)compresseurs zstd ne supportent pas l'usage concurrent : une instance par thread
# (l'API sert les replays depuis un pool de threads, l'import écrit depuis asyncio.to_thread).
_local = threading.local()


def _codec() -> tuple[zstd.ZstdCompressor, zstd.ZstdDecompressor]:
    if not hasattr(_local, "c"):
        _local.c, _local.d = zstd.ZstdCompressor(level=6), zstd.ZstdDecompressor()
    return _local.c, _local.d


def pack(obj) -> bytes:
    return _codec()[0].compress(msgpack.packb(obj, use_bin_type=True))


def unpack(b: bytes):
    return msgpack.unpackb(_codec()[1].decompress(b), raw=False)


def _arr(a: np.ndarray) -> dict:
    le = a.astype(a.dtype.newbyteorder("<"), copy=False)
    return {"dtype": le.dtype.str, "data": np.ascontiguousarray(le).tobytes()}


def _from(d: dict, shape=None) -> np.ndarray:
    a = np.frombuffer(d["data"], dtype=np.dtype(d["dtype"])).copy()
    return a.reshape(shape) if shape is not None else a


def encode_frames(fr: PRoundFrames) -> bytes:
    n, m = len(fr.ticks), len(fr.players)
    cells = [cell for row in fr.inventory for cell in row]  # ordre [tick][joueur]
    offsets = np.zeros(n * m + 1, dtype=np.uint32)
    offsets[1:] = np.cumsum(np.fromiter(map(len, cells), dtype=np.int64, count=n * m))
    items = list(itertools.chain.from_iterable(cells))
    payload = {
        "v": CODEC_VERSION, "round": fr.round_number, "n": n, "m": m,
        "ticks": _arr(fr.ticks.astype(np.int32)), "players": list(fr.players),
        "fields": {k: _arr(v.reshape(-1)) for k, v in fr.fields.items()},
        "weapons": list(fr.weapons),
        "inv_offsets": _arr(offsets), "inv_items": _arr(np.array(items, dtype=np.uint16)),
        "xhair": list(fr.xhair),  # code de réticule par joueur (PARSER_VERSION 3)
        "vm": [None if x is None else [float(v) for v in x] for x in fr.vm],  # réglages des bras par joueur
        # tirs et recul de la caméra : [tick, indice du joueur, vertical, horizontal] (tâche 1.10), plus le recul de
        # visée [vertical, horizontal] s'il a été lu (6 valeurs)
        "punch": [[int(r[0]), int(r[1]), *(float(v) for v in r[2:])] for r in fr.punch],
        "agents": list(fr.agents),  # agent équipé par joueur (None : agent par défaut)
        "forces": [[int(r[0]), int(r[1]), *(float(v) for v in r[2:])] for r in fr.forces],  # force de la mort par victime
    }
    return pack(payload)


WIRE_VERSION = 2
# Champs quantifiés pour le transport : valeur entière = round(valeur × échelle). pitch (PARSER_VERSION 3) : ±90°,
# différences ≤ 18 000 → int16. yawm et pitchm (regard au tick entre deux images, tâche 1.10) comme yaw et pitch. Les autres
# champs (duck, clip, reserve, zoom, keys, fov…), xhair, vm et punch passent tels quels.
_QUANT = {"x": 4, "y": 4, "z": 4, "yaw": 100, "pitch": 100, "yawm": 100, "pitchm": 100}


def _int_arr(a: np.ndarray) -> dict:
    """Plus petit entier signé (int16 sinon int32) qui contient toutes les valeurs."""
    dt = "<i2" if a.size == 0 or (a.min() >= -32768 and a.max() <= 32767) else "<i4"
    return {"dtype": dt, "data": np.ascontiguousarray(a.astype(dt)).tobytes()}


def frames_wire(blob: bytes) -> dict:
    """Format de transport compact (~4× plus petit une fois gzippé) :
    - x/y/z/yaw/pitch/yawm/pitchm : entiers quantifiés, différences successives par joueur, rangés joueur par joueur
      (enc « dpm », décodé côté client en float32 rangé image par image) ; un blob ancien sans pitch reste valide ;
    - inv_offsets : différences successives (enc « d »)."""
    w = unpack(blob)
    n, m = w["n"], w["m"]
    for k, scale in _QUANT.items():
        if k not in w["fields"]:
            continue
        q = np.round(_from(w["fields"][k], (n, m)).astype(np.float64) * scale).astype(np.int64)
        d = np.diff(q, axis=0, prepend=np.zeros((1, m), np.int64)) if n else q
        w["fields"][k] = {**_int_arr(np.ascontiguousarray(d.T)), "enc": "dpm", "scale": scale}
    off = _from(w["inv_offsets"]).astype(np.int64)
    w["inv_offsets"] = {**_int_arr(np.diff(off, prepend=0)), "enc": "d"}
    w["v"] = WIRE_VERSION
    return w


@dataclass
class FrameFields:
    """Lecture partielle d'un round : ticks, joueurs et quelques champs, sans les inventaires (coûteux à reconstruire,
    inutiles aux heatmaps, rôles et playbook)."""
    ticks: np.ndarray
    players: list[str]
    fields: dict[str, np.ndarray]
    weapons: list[str] = field(default_factory=list)  # table de noms du champ "weapon"


_FIELDS_CACHE: OrderedDict = OrderedDict()
_FIELDS_LOCK = threading.Lock()
# ~175 o par image décodée (10 joueurs : x, y, z, yaw en float32, flags, tick) : un round de ~100 s pèse ~300 Ko à
# 16 i/s et ~550 Ko à 32 i/s (le double) → ~330 Mo au plus quand le cache est plein de rounds à 32 i/s
_FIELDS_MAX = 600


def decode_fields(blob: bytes, keys: tuple[str, ...] = ("x", "y", "z", "yaw", "flags")) -> FrameFields:
    """Champs demandés d'un round, avec cache mémoire indexé par l'empreinte du contenu (juste même après une
    ré-analyse qui réattribue les mêmes ids de round)."""
    key = (zlib.crc32(blob), len(blob), keys)
    with _FIELDS_LOCK:
        hit = _FIELDS_CACHE.get(key)
        if hit is not None:
            _FIELDS_CACHE.move_to_end(key)
            return hit
    w = unpack(blob)
    n, m = w["n"], w["m"]
    ff = FrameFields(ticks=_from(w["ticks"]), players=w["players"],
                     fields={k: _from(w["fields"][k], (n, m)) for k in keys if k in w["fields"]}, weapons=list(w.get("weapons") or []))
    for a in (ff.ticks, *ff.fields.values()):
        a.flags.writeable = False  # partagé entre requêtes : lecture seule
    with _FIELDS_LOCK:
        _FIELDS_CACHE[key] = ff
        while len(_FIELDS_CACHE) > _FIELDS_MAX:
            _FIELDS_CACHE.popitem(last=False)
    return ff


def decode_frames(blob: bytes) -> PRoundFrames:
    w = unpack(blob)
    n, m = w["n"], w["m"]
    offsets, items = _from(w["inv_offsets"]), _from(w["inv_items"]).tolist()
    inv = [[items[offsets[i * m + j]:offsets[i * m + j + 1]] for j in range(m)] for i in range(n)]
    return PRoundFrames(
        round_number=w["round"], ticks=_from(w["ticks"]), players=w["players"],
        fields={k: _from(v, (n, m)) for k, v in w["fields"].items()},
        weapons=w["weapons"], inventory=inv, xhair=list(w.get("xhair") or []), vm=list(w.get("vm") or []),
        punch=[list(r) for r in w.get("punch") or []], agents=list(w.get("agents") or []),
        forces=[list(r) for r in w.get("forces") or []],
    )
