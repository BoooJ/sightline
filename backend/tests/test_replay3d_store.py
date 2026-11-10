# backend/tests/test_replay3d_store.py
"""Cartes 3D : envoi par morceaux, reprise, vérifications, remplacement atomique, nettoyage."""
import errno
import hashlib
import json
import os
import struct
import time

import pytest

from app.modules.replay3d import store

W2M = [0, 0.0254, 0, 0, 0, 0, 0.0254, 0, 0.0254, 0, 0, 0, 0, 0, 0, 1]
FREE = 100 * 1024 ** 3


def make_glb(pad: bytes = b"") -> bytes:
    """Plus petit glTF binaire valide (version 2) ; le bourrage fait varier le contenu."""
    js = json.dumps({"asset": {"version": "2.0"}, "extras": {"pad": pad.hex()}}).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js
    return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


def meta(data: bytes, **extra) -> dict:
    return {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "build": "2000873",
            "exported_at": "2026-10-26T18:00:00Z", "tool": "map3d 1", "world_to_model": W2M,
            "checks": {"bomb_a": 41.5, "bomb_b": 37.0}, **extra}


def send(tmp_path, data: bytes, variant="gray", chunk=7) -> dict:
    st = store.begin(tmp_path, "de_nuke", variant, meta(data), FREE)
    for off in range(st["received"], len(data), chunk):
        store.write_chunk(tmp_path, st["id"], off, data[off:off + chunk], FREE)
    return store.complete(tmp_path, st["id"])


def uploads(tmp_path):
    return list((tmp_path / "maps3d" / ".uploads").iterdir())


def test_envoi_complet_puis_lecture(tmp_path):
    data = make_glb(b"a" * 50)
    pub = send(tmp_path, data)
    file = f"gray-{hashlib.sha256(data).hexdigest()[:12]}.glb"
    assert pub["variants"]["gray"] == {"url": f"/api/maps3d/de_nuke/{file}", "size": len(data)}
    assert pub["world_to_model"] == W2M and pub["build"] == "2000873" and pub["checks"]["bomb_a"] == 41.5
    assert store.file_path(tmp_path, "de_nuke", file).read_bytes() == data
    assert [m["map"] for m in store.list_maps(tmp_path)] == ["de_nuke"]
    assert uploads(tmp_path) == []


def test_reprise_et_decalage_faux(tmp_path):
    data = make_glb(b"b" * 40)
    st = store.begin(tmp_path, "de_nuke", "gray", meta(data), FREE)
    store.write_chunk(tmp_path, st["id"], 0, data[:10], FREE)
    assert store.begin(tmp_path, "de_nuke", "gray", meta(data), FREE) == {"id": st["id"], "received": 10, "size": len(data)}
    with pytest.raises(store.StoreError) as e:
        store.write_chunk(tmp_path, st["id"], 20, data[20:30], FREE)
    assert e.value.status == 409 and e.value.detail == {"received": 10}
    with pytest.raises(store.StoreError) as e:
        store.complete(tmp_path, st["id"])
    assert e.value.status == 409


def test_reprise_apres_un_nouvel_export(tmp_path):
    """Relancer le script refait l'export (exported_at, build… nouveaux) : même fichier, l'envoi reprend quand même."""
    data = make_glb(b"r" * 40)
    st = store.begin(tmp_path, "de_nuke", "gray", meta(data), FREE)
    store.write_chunk(tmp_path, st["id"], 0, data[:10], FREE)
    again = meta(data, exported_at="2026-10-27T09:00:00Z", build="2000900", tool="map3d 2", checks={"bomb_a": 40.0},
                 world_to_model=[*W2M[:15], 2])
    assert store.begin(tmp_path, "de_nuke", "gray", again, FREE) == {"id": st["id"], "received": 10, "size": len(data)}
    store.write_chunk(tmp_path, st["id"], 10, data[10:], FREE)
    pub = store.complete(tmp_path, st["id"])
    assert (pub["exported_at"], pub["build"], pub["checks"]) == ("2026-10-27T09:00:00Z", "2000900", {"bomb_a": 40.0})
    assert pub["world_to_model"][15] == 2 and store.manifest(tmp_path, "de_nuke")["tool"] == "map3d 2"


def test_reprise_taille_differente_repart_de_zero(tmp_path):
    data = make_glb(b"s" * 40)
    st = store.begin(tmp_path, "de_nuke", "gray", meta(data), FREE)
    store.write_chunk(tmp_path, st["id"], 0, data[:10], FREE)
    assert store.begin(tmp_path, "de_nuke", "gray", meta(data, size=len(data) + 4), FREE)["received"] == 0


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), 10 ** 400])
@pytest.mark.parametrize("field", ["world_to_model", "checks"])
def test_nombres_non_finis_refuses(tmp_path, field, bad):
    data = make_glb()
    extra = {"world_to_model": [bad, *W2M[1:]]} if field == "world_to_model" else {"checks": {"bomb_a": bad}}
    with pytest.raises(store.StoreError) as e:
        store.begin(tmp_path, "de_nuke", "gray", meta(data, **extra), FREE)
    assert e.value.status == 400 and field in e.value.detail


@pytest.mark.parametrize("bad", [
    {"map": "de_mirage", "world_to_model": [float("nan")] * 16, "variants": {"gray": {"file": "gray-0123456789ab.glb",
                                                                                      "size": 10}}},
    {"map": "de_mirage", "variants": {"gray": {"file": "gray-0123456789ab.glb", "size": 10}}},
    {"map": "de_mirage", "world_to_model": W2M, "variants": {"gray": "gray-0123456789ab.glb"}},
    ["pas", "un", "objet"],
])
def test_liste_ignore_un_manifeste_invalide(tmp_path, bad):
    """Un manifeste abîmé (nombre non fini, champ manquant) n'empêche pas de lister les autres cartes."""
    send(tmp_path, make_glb())
    d = tmp_path / "maps3d" / "de_mirage"
    d.mkdir()
    (d / "gray-0123456789ab.glb").write_bytes(make_glb())
    (d / "manifest.json").write_text(json.dumps(bad), encoding="utf-8")
    lst = [store.public(m) for m in store.list_maps(tmp_path)]
    assert [m["map"] for m in lst] == ["de_nuke"]
    json.dumps(lst, allow_nan=False)  # ce que fait la réponse JSON de la route
    with pytest.raises(store.StoreError) as e:
        store.file_path(tmp_path, "de_mirage", "gray-0123456789ab.glb")
    assert e.value.status == 404


def test_somme_hors_du_verrou_et_double_validation(tmp_path, monkeypatch):
    """Le sha256 (jusqu'à 300 Mo) se calcule hors du verrou ; une seconde validation (nouvel essai après une réponse
    perdue) qui passe pendant ce calcul ne fait pas tomber la première en erreur 500."""
    data = make_glb(b"d" * 20)
    st = store.begin(tmp_path, "de_nuke", "gray", meta(data), FREE)
    store.write_chunk(tmp_path, st["id"], 0, data, FREE)
    real, other = store._sha256, []

    def sha(path):
        assert not store._lock.locked()
        h = real(path)
        if not other:
            other.append(None)
            other[0] = store.complete(tmp_path, st["id"])
        return h

    monkeypatch.setattr(store, "_sha256", sha)
    with pytest.raises(store.StoreError) as e:
        store.complete(tmp_path, st["id"])
    assert e.value.status == 404
    assert other[0]["variants"]["gray"]["size"] == len(data) and uploads(tmp_path) == []


def test_place_disque_reverifiee_a_chaque_morceau(tmp_path, monkeypatch):
    data = make_glb(b"p" * 40)
    st = store.begin(tmp_path, "de_nuke", "gray", meta(data), FREE)
    store.write_chunk(tmp_path, st["id"], 0, data[:10], FREE)
    with pytest.raises(store.StoreError) as e:
        store.write_chunk(tmp_path, st["id"], 10, data[10:20], free=1024)
    assert e.value.status == 507

    def full(part, chunk):  # disque plein en pleine écriture : quelques octets passent, puis ENOSPC
        with open(part, "ab") as f:
            f.write(chunk[:3])
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(store, "_append", full, raising=False)
    with pytest.raises(store.StoreError) as e:
        store.write_chunk(tmp_path, st["id"], 10, data[10:20], FREE)
    assert e.value.status == 507
    monkeypatch.undo()
    # rien de bancal : le .part est revenu à 10 octets et l'envoi reprend là
    assert store.begin(tmp_path, "de_nuke", "gray", meta(data), FREE)["received"] == 10


@pytest.mark.parametrize("data,extra", [(make_glb(b"c"), {"sha256": "0" * 64}), (b"pas un glb, juste du texte", {})])
def test_fichier_refuse(tmp_path, data, extra):
    st = store.begin(tmp_path, "de_nuke", "gray", meta(data, **extra), FREE)
    store.write_chunk(tmp_path, st["id"], 0, data, FREE)
    with pytest.raises(store.StoreError) as e:
        store.complete(tmp_path, st["id"])
    assert e.value.status == 400
    assert store.list_maps(tmp_path) == [] and uploads(tmp_path) == []


def test_limites(tmp_path):
    data = make_glb()
    for body, status in ((meta(data, size=store.MAX_SIZE + 1), 413), (meta(data, world_to_model=[1] * 15), 400),
                         (meta(data, sha256="xyz"), 400), (meta(data, checks={"a": "loin"}), 400)):
        with pytest.raises(store.StoreError) as e:
            store.begin(tmp_path, "de_nuke", "gray", body, FREE)
        assert e.value.status == status
    with pytest.raises(store.StoreError) as e:
        store.begin(tmp_path, "de_nuke", "gray", meta(data), free=1024)
    assert e.value.status == 507
    for name, variant in (("de_nuke", "bleu"), ("../etc", "gray"), ("de_nuke\n", "gray")):
        with pytest.raises(store.StoreError) as e:
            store.begin(tmp_path, name, variant, meta(data), FREE)
        assert e.value.status == 404
    with pytest.raises(store.StoreError) as e:
        store.write_chunk(tmp_path, "a" * 32, 0, b"x" * (store.MAX_CHUNK + 1), FREE)
    assert e.value.status == 413


def test_somme_et_identifiant_avec_saut_de_ligne_refuses(tmp_path):
    """Ancre de fin en `$` : un saut de ligne final ne doit pas passer pour une somme ou un identifiant valides."""
    data = make_glb(b"n" * 20)
    with pytest.raises(store.StoreError) as e:
        store.begin(tmp_path, "de_nuke", "gray", meta(data, sha256=meta(data)["sha256"] + "\n"), FREE)
    assert e.value.status == 400
    st = store.begin(tmp_path, "de_nuke", "gray", meta(data), FREE)
    with pytest.raises(store.StoreError) as e:
        store.write_chunk(tmp_path, st["id"] + "\n", 0, data, FREE)
    assert e.value.status == 400


def test_remplacement_atomique(tmp_path):
    v1, v2 = make_glb(b"1" * 30), make_glb(b"2" * 30)
    f1 = send(tmp_path, v1)["variants"]["gray"]["url"].rsplit("/", 1)[1]
    st = store.begin(tmp_path, "de_nuke", "gray", meta(v2), FREE)
    store.write_chunk(tmp_path, st["id"], 0, v2, FREE)
    assert store.file_path(tmp_path, "de_nuke", f1).read_bytes() == v1  # toujours servi pendant l'envoi
    f2 = store.complete(tmp_path, st["id"])["variants"]["gray"]["url"].rsplit("/", 1)[1]
    assert f2 != f1 and store.file_path(tmp_path, "de_nuke", f2).read_bytes() == v2
    assert not (tmp_path / "maps3d" / "de_nuke" / f1).exists()
    with pytest.raises(store.StoreError):
        store.file_path(tmp_path, "de_nuke", f1)


def test_deux_variantes_et_suppression(tmp_path):
    send(tmp_path, make_glb(b"g"), "gray")
    assert set(send(tmp_path, make_glb(b"t"), "textured")["variants"]) == {"gray", "textured"}
    store.delete_map(tmp_path, "de_nuke")
    assert store.list_maps(tmp_path) == []
    with pytest.raises(store.StoreError) as e:
        store.delete_map(tmp_path, "de_nuke")
    assert e.value.status == 404


@pytest.mark.parametrize("name", ["../manifest.json", "manifest.json", "gray-zzzzzzzzzzzz.glb", "gray-0123456789ab.glb", "collision-zzzzzzzzzzzz.glb"])
def test_nom_de_fichier_refuse(tmp_path, name):
    send(tmp_path, make_glb())
    with pytest.raises(store.StoreError) as e:
        store.file_path(tmp_path, "de_nuke", name)
    assert e.value.status == 404


def test_nettoyage_des_envois_abandonnes(tmp_path):
    data = make_glb()
    st = store.begin(tmp_path, "de_nuke", "gray", meta(data), FREE)
    old = time.time() - store.STALE_S - 60
    for p in uploads(tmp_path):
        os.utime(p, (old, old))
    assert store.clean_stale(tmp_path) == 2
    with pytest.raises(store.StoreError) as e:
        store.write_chunk(tmp_path, st["id"], 0, data, FREE)
    assert e.value.status == 404


def test_collision_a_cote_de_la_carte(tmp_path):
    """Variante « collision » (corps des morts du replay 3D) : à côté de la grise et de la texturée, sans réécrire les
    champs de tête du manifeste (build, world_to_model, checks : ceux de la carte)."""
    send(tmp_path, make_glb(b"g"), "gray")
    col = make_glb(b"c" * 20)
    st = store.begin(tmp_path, "de_nuke", "collision", meta(col, build="2000999", checks={}), FREE)
    store.write_chunk(tmp_path, st["id"], 0, col, FREE)
    pub = store.complete(tmp_path, st["id"])
    file = f"collision-{hashlib.sha256(col).hexdigest()[:12]}.glb"
    assert pub["variants"]["collision"] == {"url": f"/api/maps3d/de_nuke/{file}", "size": len(col)}
    assert set(pub["variants"]) == {"gray", "collision"}
    assert pub["build"] == "2000873" and pub["checks"] == {"bomb_a": 41.5, "bomb_b": 37.0}
    assert store.file_path(tmp_path, "de_nuke", file).read_bytes() == col


def test_collision_seule_puis_carte(tmp_path):
    """Collision envoyée avant la carte : manifeste servable (champs de tête pris d'elle) ; la carte les réécrit ensuite."""
    send(tmp_path, make_glb(b"c"), "collision")
    only = store.list_maps(tmp_path)
    assert [m["map"] for m in only] == ["de_nuke"] and set(store.public(only[0])["variants"]) == {"collision"}
    gray = make_glb(b"g")
    st = store.begin(tmp_path, "de_nuke", "gray", meta(gray, build="2001000"), FREE)
    store.write_chunk(tmp_path, st["id"], 0, gray, FREE)
    pub = store.complete(tmp_path, st["id"])
    assert pub["build"] == "2001000" and set(pub["variants"]) == {"gray", "collision"}


def test_variante_inconnue_liste_les_variantes(tmp_path):
    with pytest.raises(store.StoreError) as e:
        store.begin(tmp_path, "de_nuke", "couleur", meta(make_glb()), FREE)
    assert e.value.status == 404 and "collision" in str(e.value.detail)
