# backend/tests/test_replay3d.py
"""Module replay3d : routes des cartes 3D (droits, envoi complet, fichier servi, module coupé)."""
import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.core.config import ROOT, Settings
from app.main import create_app
from app.modules.replay3d import store
from tests.test_api import client, fixture_parse  # noqa: F401  (fixture : app sans le module)
from tests.test_replay3d_store import W2M, make_glb, meta

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}


@pytest.fixture
def c3d(tmp_path):
    s = Settings(data_dir=tmp_path / "data", maps_dir=ROOT / "maps", frontend_dist=tmp_path / "nodist",
                 demo_folders=[tmp_path / "demos"], modules=["replay3d"])
    s._config_path = tmp_path / "config.toml"
    (tmp_path / "demos").mkdir()
    app = create_app(s, parse_fn=fixture_parse, executor_factory=lambda n: ThreadPoolExecutor(n))
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        yield c


def upload(c, data: bytes, variant="gray", chunk=16):
    st = c.post(f"/api/maps3d/de_nuke/{variant}/upload", json=meta(data))
    assert st.status_code == 200, st.text
    st = st.json()
    for off in range(st["received"], len(data), chunk):
        r = c.put(f"/api/maps3d/uploads/{st['id']}?offset={off}", content=data[off:off + chunk])
        assert r.status_code == 200, r.text
    return c.post(f"/api/maps3d/uploads/{st['id']}/complete")


def test_module_coupe(client):
    c, _ = client
    assert c.get("/api/maps3d").status_code == 404
    assert "replay3d" not in c.get("/api/health").json()["modules"]


def test_envoi_puis_fichier_servi(c3d):
    assert c3d.get("/api/health").json()["modules"] == ["replay3d"]
    assert c3d.get("/api/maps3d").json() == []
    data = make_glb(b"x" * 100)
    r = upload(c3d, data)
    assert r.status_code == 200, r.text
    lst = c3d.get("/api/maps3d").json()
    assert len(lst) == 1 and lst[0]["map"] == "de_nuke" and lst[0]["variants"]["gray"]["size"] == len(data)
    url = lst[0]["variants"]["gray"]["url"]
    f = c3d.get(url)
    assert f.status_code == 200 and f.content == data
    assert f.headers["content-type"] == "model/gltf-binary"
    assert f.headers["cache-control"] == "private, max-age=31536000, immutable"
    assert c3d.get("/api/maps3d/de_nuke/..%2Fmanifest.json").status_code == 404
    assert c3d.delete("/api/maps3d/de_nuke").json() == {"ok": True}
    assert c3d.get(url).status_code == 404


def test_carte_inconnue_et_fichier_invalide(c3d):
    assert c3d.post("/api/maps3d/de_atlantis/gray/upload", json=meta(make_glb())).status_code == 404
    r = upload(c3d, b"texte et pas glb")
    assert r.status_code == 400 and "glTF" in r.json()["detail"]
    assert c3d.put(f"/api/maps3d/uploads/{'f' * 32}?offset=0", content=b"x").status_code == 404


def test_reprise_par_les_routes(c3d):
    """Contrat du script d'envoi : reprise au début, et 409 {detail: {received}} sur un décalage faux."""
    data = make_glb(b"z" * 60)
    st = c3d.post("/api/maps3d/de_nuke/gray/upload", json=meta(data)).json()
    assert c3d.put(f"/api/maps3d/uploads/{st['id']}?offset=0", content=data[:16]).status_code == 200
    r = c3d.put(f"/api/maps3d/uploads/{st['id']}?offset=0", content=data[:16])  # réponse perdue, même morceau renvoyé
    assert r.status_code == 409 and r.json() == {"detail": {"received": 16}}
    again = c3d.post("/api/maps3d/de_nuke/gray/upload", json=meta(data, exported_at="2026-10-28T10:00:00Z"))
    assert again.json() == {"id": st["id"], "received": 16, "size": len(data)}
    assert c3d.put(f"/api/maps3d/uploads/{st['id']}?offset=16", content=data[16:]).json() == {"received": len(data)}
    assert c3d.post(f"/api/maps3d/uploads/{st['id']}/complete").json()["exported_at"] == "2026-10-28T10:00:00Z"


def test_nombres_non_finis_et_liste_toujours_servie(c3d, tmp_path):
    data = make_glb()
    for raw in ("NaN", "Infinity", "-Infinity", "1e400"):
        body = json.dumps(meta(data, world_to_model=["X", *W2M[1:]])).replace('"X"', raw)
        r = c3d.post("/api/maps3d/de_nuke/gray/upload", content=body, headers={"content-type": "application/json"})
        assert r.status_code == 400, raw
    assert upload(c3d, data).status_code == 200
    d = tmp_path / "data" / "maps3d" / "de_mirage"  # manifeste abîmé laissé par une ancienne version
    d.mkdir()
    (d / "manifest.json").write_text('{"map": "de_mirage", "world_to_model": [NaN], "checks": {}, "variants": '
                                     '{"gray": {"file": "gray-0123456789ab.glb", "size": 1}}}', encoding="utf-8")
    r = c3d.get("/api/maps3d")
    assert r.status_code == 200 and [m["map"] for m in r.json()] == ["de_nuke"]


def test_morceau_trop_gros_refuse_avant_lecture(c3d, monkeypatch):
    """Content-Length trop grand ou absent : 413 sans lire le corps en mémoire (Request.body jamais appelé)."""
    def begin():
        return c3d.post("/api/maps3d/de_nuke/gray/upload", json=meta(make_glb(b"q" * 40)))

    st = begin().json()
    url = f"/api/maps3d/uploads/{st['id']}?offset=0"
    real, reads = Request.body, []

    async def spy(self):
        reads.append(self.method)
        return await real(self)

    monkeypatch.setattr(Request, "body", spy)
    r = c3d.put(url, content=b"x", headers={"content-length": str(store.MAX_CHUNK + 1)})  # annoncé trop gros
    assert r.status_code == 413
    assert c3d.put(url, content=iter([b"x"])).status_code == 413  # envoi « chunked », sans Content-Length
    assert reads == []  # refusés sur l'en-tête : corps jamais lu
    assert begin().json()["received"] == 0
    assert c3d.put(url, content=b"x").status_code == 200  # témoin : l'espion voit bien la lecture d'un morceau accepté
    assert reads.count("PUT") == 1


def test_morceau_ecrit_hors_de_la_boucle(c3d, monkeypatch):
    """L'écriture (verrou, disque) tourne dans un thread : la boucle d'événements, seule pour tout le site, reste libre."""
    real, where = store.write_chunk, []

    def spy(*args):
        try:
            asyncio.get_running_loop()
            where.append("boucle")
        except RuntimeError:
            where.append("thread")
        return real(*args)

    monkeypatch.setattr(store, "write_chunk", spy)
    assert upload(c3d, make_glb(b"t" * 20)).status_code == 200
    assert where and set(where) == {"thread"}


def test_gros_fichier_servi_entier(c3d):
    """Plusieurs blocs de lecture : contenu exact, taille annoncée. Jamais recompressé, même demandé en gzip : les .glb le
    sont déjà (meshopt, WebP), gzip ne coûterait que du CPU au serveur (2 cœurs). Le JSON de l'API, lui, l'est toujours."""
    data = make_glb(b"w" * 1_200_000)  # ≈ 2,4 Mo
    assert upload(c3d, data, chunk=1024 ** 2).status_code == 200
    url = c3d.get("/api/maps3d").json()[0]["variants"]["gray"]["url"]
    plain = c3d.get(url, headers={"accept-encoding": "identity"})
    assert plain.content == data and plain.headers["content-length"] == str(len(data))
    asked = c3d.get(url, headers={"accept-encoding": "gzip"})
    assert asked.headers["content-type"] == "model/gltf-binary"
    assert "content-encoding" not in asked.headers and asked.content == data
    assert asked.headers["content-length"] == str(len(data))
    api = c3d.get("/openapi.json", headers={"accept-encoding": "gzip"})  # JSON de plus de 1 Ko (seuil du gzip)
    assert api.status_code == 200 and api.headers["content-type"] == "application/json"
    assert api.headers.get("content-encoding") == "gzip" and api.json()["paths"]


def test_fichier_disparu_pendant_la_demande(c3d, monkeypatch):
    """Remplacé (complete d'un nouvel envoi) entre la lecture du manifeste et l'ouverture : 404, pas 500."""
    assert upload(c3d, make_glb(b"v")).status_code == 200
    url = c3d.get("/api/maps3d").json()[0]["variants"]["gray"]["url"]
    real = store.file_path

    def vanished(*args):
        p = real(*args)
        p.unlink()
        return p

    monkeypatch.setattr(store, "file_path", vanished)
    assert c3d.get(url).status_code == 404


def test_droits(c3d):
    assert c3d.post("/api/auth/setup", json=OWNER).status_code == 200
    assert upload(c3d, make_glb()).status_code == 200  # le propriétaire envoie
    inv = c3d.post("/api/team/invites", json={"role": "member"}).json()
    r = c3d.post("/api/auth/register", json={"token": inv["token"], "username": "joueur1", "display_name": "Joueur 1",
                                             "password": "motdepasse2"})
    assert r.status_code == 200 and r.json()["user"]["role"] == "member"
    assert c3d.get("/api/maps3d").status_code == 200  # un membre voit la liste
    assert c3d.post("/api/maps3d/de_nuke/gray/upload", json=meta(make_glb(b"m"))).status_code == 403
    assert c3d.post("/api/maps3d/de_nuke/collision/upload", json=meta(make_glb(b"k"))).status_code == 403  # collision : comme les autres
    assert c3d.delete("/api/maps3d/de_nuke").status_code == 403
    c3d.post("/api/auth/logout")
    assert c3d.get("/api/maps3d").status_code == 401


def test_collision_servie_aux_connectes_seulement(c3d):
    """Variante « collision » : envoyée comme les autres (propriétaire), servie aux connectés, 401 déconnecté."""
    assert c3d.post("/api/auth/setup", json=OWNER).status_code == 200
    data = make_glb(b"k" * 40)
    assert upload(c3d, data, "collision").status_code == 200
    url = c3d.get("/api/maps3d").json()[0]["variants"]["collision"]["url"]
    assert c3d.get(url).content == data
    c3d.post("/api/auth/logout")
    assert c3d.get(url).status_code == 401
