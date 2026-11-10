# backend/tests/test_replay3d_assets.py
"""Fichiers 3D autres que les cartes (bras et armes de la vue du joueur) : stockage par type dans data/assets3d/<type>/
et routes /api/assets3d, à côté de /api/maps3d qui ne change pas."""
import hashlib
import io
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.core.config import ROOT, Settings
from app.main import create_app
from app.modules.replay3d import assets, store
from tests.test_api import client, fixture_parse, wait_ready  # noqa: F401  (fixture client : app sans le module)
from tests.test_replay3d import OWNER, c3d  # noqa: F401  (fixture : app avec le module)
from tests.test_replay3d import upload as upload_map
from tests.test_replay3d_store import FREE, make_glb


def ameta(data: bytes, **extra) -> dict:
    return {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "build": "2000935",
            "exported_at": "2026-10-30T10:00:00Z", "tool": "vue 1", **extra}


def send(tmp_path, name: str, data: bytes, kind="vue", chunk=7) -> dict:
    st = assets.begin(tmp_path, kind, name, ameta(data), FREE)
    for off in range(st["received"], len(data), chunk):
        assets.write_chunk(tmp_path, st["id"], off, data[off:off + chunk], FREE)
    return assets.complete(tmp_path, st["id"])


def pending(tmp_path):
    return list((tmp_path / "assets3d" / ".uploads").iterdir())


def test_envoi_liste_et_fichier(tmp_path):
    bras, ak = make_glb(b"b" * 40), make_glb(b"a" * 60)
    send(tmp_path, "bras-ct", bras)
    pub = send(tmp_path, "arme-ak47", ak)
    file = f"arme-ak47-{hashlib.sha256(ak).hexdigest()[:12]}.glb"
    assert pub["files"]["arme-ak47"] == {"url": f"/api/assets3d/vue/{file}", "size": len(ak)}
    assert set(pub["files"]) == {"bras-ct", "arme-ak47"} and pub["build"] == "2000935"
    assert assets.list_all(tmp_path) == {"vue": pub}
    assert assets.file_path(tmp_path, "vue", file).read_bytes() == ak
    assert pending(tmp_path) == []
    assert store.list_maps(tmp_path) == []  # rien sous data/maps3d


def test_remplacement_et_reprise(tmp_path):
    v1, v2 = make_glb(b"1" * 30), make_glb(b"2" * 30)
    f1 = send(tmp_path, "bras-t", v1)["files"]["bras-t"]["url"].rsplit("/", 1)[1]
    st = assets.begin(tmp_path, "vue", "bras-t", ameta(v2), FREE)
    assets.write_chunk(tmp_path, st["id"], 0, v2[:10], FREE)
    again = assets.begin(tmp_path, "vue", "bras-t", ameta(v2, exported_at="2026-10-30T11:00:00Z"), FREE)
    assert again == {"id": st["id"], "received": 10, "size": len(v2)}
    assert assets.file_path(tmp_path, "vue", f1).read_bytes() == v1  # toujours servi pendant l'envoi
    with pytest.raises(store.StoreError) as e:
        assets.write_chunk(tmp_path, st["id"], 20, v2[20:], FREE)
    assert e.value.status == 409 and e.value.detail == {"received": 10}
    assets.write_chunk(tmp_path, st["id"], 10, v2[10:], FREE)
    pub = assets.complete(tmp_path, st["id"])
    assert pub["exported_at"] == "2026-10-30T11:00:00Z"
    assert not (tmp_path / "assets3d" / "vue" / f1).exists()
    with pytest.raises(store.StoreError) as e:
        assets.file_path(tmp_path, "vue", f1)
    assert e.value.status == 404


@pytest.mark.parametrize("kind,name", [("armes", "bras-ct"), ("../x", "bras-ct"), ("vue", "../x"), ("vue", "Bras"),
                                       ("vue", "-bras"), ("vue", "a" * 49), ("vue", "bras-ct\n")])
def test_type_ou_nom_refuse(tmp_path, kind, name):
    with pytest.raises(store.StoreError) as e:
        assets.begin(tmp_path, kind, name, ameta(make_glb()), FREE)
    assert e.value.status == 404


def test_limites(tmp_path):
    data = make_glb()
    for body, status in ((ameta(data, size=assets.MAX_SIZE + 1), 413), (ameta(data, sha256="xyz"), 400),
                         (ameta(data, size=0), 400)):
        with pytest.raises(store.StoreError) as e:
            assets.begin(tmp_path, "vue", "bras-ct", body, FREE)
        assert e.value.status == status
    with pytest.raises(store.StoreError) as e:
        assets.begin(tmp_path, "vue", "bras-ct", ameta(data), free=1024)
    assert e.value.status == 507 and "fichiers 3D" in e.value.detail


@pytest.mark.parametrize("data,extra", [(make_glb(b"c"), {"sha256": "0" * 64}), (b"pas un glb, juste du texte", {})])
def test_fichier_refuse(tmp_path, data, extra):
    st = assets.begin(tmp_path, "vue", "bras-ct", ameta(data, **extra), FREE)
    assets.write_chunk(tmp_path, st["id"], 0, data, FREE)
    with pytest.raises(store.StoreError) as e:
        assets.complete(tmp_path, st["id"])
    assert e.value.status == 400
    assert assets.list_all(tmp_path) == {} and pending(tmp_path) == []


@pytest.mark.parametrize("name", ["../manifest.json", "manifest.json", "bras-ct-zzzzzzzzzzzz.glb", "bras-ct-0123456789ab.glb"])
def test_nom_de_fichier_refuse(tmp_path, name):
    send(tmp_path, "bras-ct", make_glb())
    with pytest.raises(store.StoreError) as e:
        assets.file_path(tmp_path, "vue", name)
    assert e.value.status == 404


def test_manifeste_abime_ignore_puis_reecrit(tmp_path):
    d = tmp_path / "assets3d" / "vue"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text('{"kind": "vue", "files": {"bras-ct": {"file": "bras-ct-0123456789ab.glb", '
                                     '"size": NaN}}}', encoding="utf-8")
    assert assets.list_all(tmp_path) == {}
    json.dumps(assets.list_all(tmp_path), allow_nan=False)
    pub = send(tmp_path, "bras-t", make_glb(b"t"))
    assert set(pub["files"]) == {"bras-t"}  # l'entrée abîmée n'est pas reprise
    (d / "manifest.json").write_text('["pas", "un", "objet"]', encoding="utf-8")
    assert set(send(tmp_path, "bras-t", make_glb(b"u"))["files"]) == {"bras-t"}


def test_envois_cartes_et_fichiers_separes(tmp_path):
    """Un envoi de fichier 3D n'est pas un envoi de carte : chacun son dossier, ses identifiants et son nettoyage."""
    data = make_glb(b"s" * 20)
    st = assets.begin(tmp_path, "vue", "bras-ct", ameta(data), FREE)
    with pytest.raises(store.StoreError) as e:
        store.write_chunk(tmp_path, st["id"], 0, data, FREE)
    assert e.value.status == 404
    old = time.time() - store.STALE_S - 60
    for p in pending(tmp_path):
        os.utime(p, (old, old))
    assert store.clean_stale(tmp_path) == 0
    assert assets.clean_stale(tmp_path) == 2
    with pytest.raises(store.StoreError) as e:
        assets.write_chunk(tmp_path, st["id"], 0, data, FREE)
    assert e.value.status == 404


def upload(c, name: str, data: bytes, chunk=16, kind="vue"):
    st = c.post(f"/api/assets3d/{kind}/{name}/upload", json=ameta(data))
    assert st.status_code == 200, st.text
    st = st.json()
    for off in range(st["received"], len(data), chunk):
        r = c.put(f"/api/assets3d/uploads/{st['id']}?offset={off}", content=data[off:off + chunk])
        assert r.status_code == 200, r.text
    return c.post(f"/api/assets3d/uploads/{st['id']}/complete")


def test_module_coupe(client):
    c, _ = client
    assert c.get("/api/assets3d").status_code == 404


def test_routes_envoi_liste_fichier(c3d):
    assert c3d.get("/api/assets3d").json() == {}
    data = make_glb(b"x" * 100)
    r = upload(c3d, "arme-ak47", data)
    assert r.status_code == 200, r.text
    lst = c3d.get("/api/assets3d").json()
    assert list(lst) == ["vue"] and lst["vue"]["files"]["arme-ak47"]["size"] == len(data)
    url = lst["vue"]["files"]["arme-ak47"]["url"]
    f = c3d.get(url)
    assert f.status_code == 200 and f.content == data
    assert f.headers["content-type"] == "model/gltf-binary"
    assert f.headers["cache-control"] == "private, max-age=31536000, immutable"
    assert c3d.get("/api/assets3d/vue/..%2Fmanifest.json").status_code == 404
    assert c3d.get(url.replace("/vue/", "/joueurs/")).status_code == 404
    assert c3d.get("/api/maps3d").json() == []  # les cartes ne voient rien
    assert upload_map(c3d, make_glb(b"carte")).status_code == 200  # et marchent toujours à côté
    assert list(c3d.get("/api/assets3d").json()["vue"]["files"]) == ["arme-ak47"]


def test_fichier_jamais_recompresse(c3d):
    """Fichier « vue » demandé en gzip : servi tel quel (déjà compressé par meshopt et WebP), taille annoncée exacte."""
    data = make_glb(b"g" * 50_000)  # bien au-dessus du seuil du gzip (1 Ko)
    assert upload(c3d, "bras-ct", data, chunk=64 * 1024).status_code == 200
    url = c3d.get("/api/assets3d").json()["vue"]["files"]["bras-ct"]["url"]
    f = c3d.get(url, headers={"accept-encoding": "gzip"})
    assert f.status_code == 200 and f.content == data and f.headers["content-type"] == "model/gltf-binary"
    assert "content-encoding" not in f.headers and f.headers["content-length"] == str(len(data))


def test_routes_refus(c3d):
    assert c3d.post("/api/assets3d/armes/bras-ct/upload", json=ameta(make_glb())).status_code == 404
    assert upload(c3d, "bras-ct", b"texte et pas glb").status_code == 400
    st = c3d.post("/api/assets3d/vue/bras-ct/upload", json=ameta(make_glb(b"q" * 40))).json()
    r = c3d.put(f"/api/assets3d/uploads/{st['id']}?offset=0", content=b"x",
                headers={"content-length": str(store.MAX_CHUNK + 1)})
    assert r.status_code == 413
    assert c3d.put(f"/api/maps3d/uploads/{st['id']}?offset=0", content=b"x").status_code == 404  # pas un envoi de carte


def test_droits(c3d):
    assert c3d.post("/api/auth/setup", json=OWNER).status_code == 200
    assert upload(c3d, "bras-ct", make_glb()).status_code == 200  # le propriétaire envoie
    inv = c3d.post("/api/team/invites", json={"role": "member"}).json()
    r = c3d.post("/api/auth/register", json={"token": inv["token"], "username": "joueur1", "display_name": "Joueur 1",
                                             "password": "motdepasse2"})
    assert r.status_code == 200 and r.json()["user"]["role"] == "member"
    lst = c3d.get("/api/assets3d")
    assert lst.status_code == 200  # un membre voit la liste et les fichiers
    assert c3d.get(lst.json()["vue"]["files"]["bras-ct"]["url"]).status_code == 200
    assert c3d.post("/api/assets3d/vue/bras-t/upload", json=ameta(make_glb(b"m"))).status_code == 403
    assert c3d.put(f"/api/assets3d/uploads/{'a' * 32}?offset=0", content=b"x").status_code == 403
    c3d.post("/api/auth/logout")
    assert c3d.get("/api/assets3d").status_code == 401


def test_fichier_sans_session_refuse(c3d):
    """Les fichiers de Valve ne se téléchargent pas sans session, pas seulement la liste."""
    assert c3d.post("/api/auth/setup", json=OWNER).status_code == 200
    assert upload(c3d, "bras-ct", make_glb()).status_code == 200
    url = c3d.get("/api/assets3d").json()["vue"]["files"]["bras-ct"]["url"]
    assert c3d.get(url).status_code == 200
    c3d.post("/api/auth/logout")
    assert c3d.get(url).status_code == 401


def test_membre_ne_termine_pas_un_envoi(c3d):
    """Terminer un envoi est réservé à l'administrateur : le membre reçoit 403 et l'envoi reste en attente."""
    assert c3d.post("/api/auth/setup", json=OWNER).status_code == 200
    data = make_glb(b"m" * 30)
    st = c3d.post("/api/assets3d/vue/bras-t/upload", json=ameta(data)).json()
    assert c3d.put(f"/api/assets3d/uploads/{st['id']}?offset=0", content=data).status_code == 200
    inv = c3d.post("/api/team/invites", json={"role": "member"}).json()
    r = c3d.post("/api/auth/register", json={"token": inv["token"], "username": "joueur1", "display_name": "Joueur 1",
                                             "password": "motdepasse2"})
    assert r.status_code == 200 and r.json()["user"]["role"] == "member"
    assert c3d.post(f"/api/assets3d/uploads/{st['id']}/complete").status_code == 403
    assert c3d.get("/api/assets3d").json() == {}  # rien n'a été mis en place
    c3d.post("/api/auth/logout")
    assert c3d.post("/api/auth/login", json={"username": "coach", "password": "motdepasse1"}).status_code == 200
    assert c3d.post(f"/api/assets3d/uploads/{st['id']}/complete").status_code == 200  # l'administrateur termine
    assert list(c3d.get("/api/assets3d").json()["vue"]["files"]) == ["bras-t"]


def test_cle_d_api_refusee(c3d):
    """Une clé d'API, même avec tous ses droits, n'accède pas aux fichiers 3D (liste, fichier, envoi)."""
    assert c3d.post("/api/auth/setup", json=OWNER).status_code == 200
    assert upload(c3d, "bras-ct", make_glb()).status_code == 200
    url = c3d.get("/api/assets3d").json()["vue"]["files"]["bras-ct"]["url"]
    key = c3d.post("/api/integrations/keys", json={"name": "essai", "scopes": ["read", "import", "comms"]}).json()["key"]
    c3d.cookies.clear()
    bearer = {"Authorization": f"Bearer {key}"}
    assert c3d.get("/api/assets3d", headers=bearer).status_code == 403
    assert c3d.get(url, headers=bearer).status_code == 403
    assert c3d.post("/api/assets3d/vue/bras-t/upload", json=ameta(make_glb(b"k")), headers=bearer).status_code == 403
    assert c3d.put(f"/api/assets3d/uploads/{'a' * 32}?offset=0", content=b"x", headers=bearer).status_code == 403
    assert c3d.post(f"/api/assets3d/uploads/{'a' * 32}/complete", headers=bearer).status_code == 403


def test_lien_de_partage_sans_acces_aux_fichiers(c3d):
    """Un visiteur d'un lien de partage (sans session) lit le lien mais pas les fichiers 3D."""
    c3d.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c3d)
    m = c3d.get("/api/matches").json()[0]
    r2 = c3d.get(f"/api/matches/{m['id']}").json()["rounds"][1]
    assert c3d.post("/api/auth/setup", json=OWNER).status_code == 200
    assert upload(c3d, "bras-ct", make_glb()).status_code == 200
    url = c3d.get("/api/assets3d").json()["vue"]["files"]["bras-ct"]["url"]
    link = c3d.post("/api/share", json={"match_id": m["id"], "round_number": r2["number"]}).json()
    c3d.post("/api/auth/logout")
    c3d.cookies.clear()
    assert c3d.get(f"/api/share/{link['token']}").status_code == 200  # le lien marche
    assert c3d.get("/api/assets3d").status_code == 401
    assert c3d.get(url).status_code == 401
    assert c3d.get("/api/assets3d", headers={"Authorization": f"Bearer {link['token']}"}).status_code == 401


def test_nettoyage_en_echec_garde_les_routes(tmp_path, monkeypatch):
    """Un nettoyage au chargement qui échoue ne coupe ni /api/assets3d ni /api/maps3d (le module reste chargé)."""
    calls = []

    def refuse(data_dir, now=None):
        calls.append(data_dir)
        raise PermissionError("dossier verrouillé")

    monkeypatch.setattr(assets, "clean_stale", refuse)
    s = Settings(data_dir=tmp_path / "data", maps_dir=ROOT / "maps", frontend_dist=tmp_path / "nodist",
                 demo_folders=[tmp_path / "demos"], modules=["replay3d"])
    s._config_path = tmp_path / "config.toml"
    (tmp_path / "demos").mkdir()
    app = create_app(s, parse_fn=fixture_parse, executor_factory=lambda n: ThreadPoolExecutor(n))
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        assert c.get("/api/maps3d").status_code == 200
        assert c.get("/api/assets3d").status_code == 200
    assert calls  # le nettoyage des fichiers 3D est bien appelé au chargement


def test_joueurs_a_cote_de_vue(tmp_path):
    """Fichiers « joueurs » (modèles d'agents, clips, armes du monde) : leur propre dossier et manifeste, listés à côté de
    « vue » ; un même nom dans les deux types reste deux fichiers."""
    bras, agent, clips = make_glb(b"b" * 40), make_glb(b"g" * 50), make_glb(b"c" * 70)
    send(tmp_path, "bras-ct", bras)
    pub = send(tmp_path, "agent-ct", agent, kind="joueurs")
    send(tmp_path, "anims-rifle", clips, kind="joueurs")
    file = f"agent-ct-{hashlib.sha256(agent).hexdigest()[:12]}.glb"
    assert pub["files"]["agent-ct"] == {"url": f"/api/assets3d/joueurs/{file}", "size": len(agent)}
    lst = assets.list_all(tmp_path)
    assert sorted(lst) == ["joueurs", "vue"]
    assert sorted(lst["joueurs"]["files"]) == ["agent-ct", "anims-rifle"] and list(lst["vue"]["files"]) == ["bras-ct"]
    assert assets.file_path(tmp_path, "joueurs", file).read_bytes() == agent
    assert (tmp_path / "assets3d" / "joueurs" / "manifest.json").is_file()
    with pytest.raises(store.StoreError):
        assets.file_path(tmp_path, "vue", file)  # pas dans le manifeste de « vue »


def test_routes_joueurs(c3d):
    data = make_glb(b"j" * 90)
    assert upload(c3d, "agent-t", data, kind="joueurs").status_code == 200
    lst = c3d.get("/api/assets3d").json()
    assert list(lst) == ["joueurs"]
    url = lst["joueurs"]["files"]["agent-t"]["url"]
    assert url.startswith("/api/assets3d/joueurs/agent-t-") and c3d.get(url).content == data
    assert c3d.get(url.replace("/joueurs/", "/vue/")).status_code == 404
