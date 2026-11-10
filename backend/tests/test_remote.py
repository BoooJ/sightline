# backend/tests/test_remote.py
import gzip
import io

import pytest
import zstandard as zstd

from app.ingest import remote

DEMO = b"PBDEMS2\x00" + b"x" * 5000


class FakeResp(io.BytesIO):
    def __init__(self, data: bytes, headers: dict):
        super().__init__(data)
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


@pytest.fixture
def serve(monkeypatch):
    def setup(data: bytes, name: str):
        monkeypatch.setattr(remote, "check_url", lambda u: u)
        monkeypatch.setattr(remote, "_request", lambda url, **k: FakeResp(data, {"Content-Length": str(len(data)),
                                                                                  "Content-Disposition": f'attachment; filename="{name}"'}))
    return setup


def test_url_checks():
    with pytest.raises(remote.RemoteError, match="https"):
        remote.check_url("http://example.com/a.dem")
    with pytest.raises(remote.RemoteError, match="privée"):
        remote.check_url("https://127.0.0.1/a.dem")
    with pytest.raises(remote.RemoteError, match="Télécharger la démo"):
        remote.faceit_demo_url("https://www.faceit.com/fr/cs2/room/1-0a1b2c3d-1111-2222-3333-444455556666", None)
    assert remote.FACEIT_ROOM.search("https://www.faceit.com/en/cs2/room/1-0a1b2c3d-1111-2222-3333-444455556666/scoreboard")


@pytest.mark.parametrize("data,name", [
    (DEMO, "match.dem"),
    (gzip.compress(DEMO), "1-abc-1-1.dem.gz"),
    (zstd.ZstdCompressor().compress(DEMO), "1-abc-1-1.dem.zst"),
])
def test_download_decompresses(serve, tmp_path, data, name):
    serve(data, name)
    dl = remote.Download(id="t1", url="https://demos.example/x")
    [path] = remote.download(dl, tmp_path)
    assert path.suffix == ".dem" and path.read_bytes() == DEMO and dl.received == len(data)
    assert not list((tmp_path / ".partial").iterdir())


def test_download_zip_archive(serve, tmp_path):
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("serie/mouz-vs-falcons-m1-mirage.dem", DEMO)
        z.writestr("serie/mouz-vs-falcons-m2-nuke.dem", DEMO)
        z.writestr("serie/lisezmoi.txt", b"hltv")
        z.writestr("../evil.dem", b"pas une demo")
    serve(buf.getvalue(), "mouz-vs-falcons.zip")
    dl = remote.Download(id="t3", url="https://demos.example/x")
    paths = remote.download(dl, tmp_path)
    assert sorted(p.name for p in paths) == ["mouz-vs-falcons-m1-mirage.dem", "mouz-vs-falcons-m2-nuke.dem"]
    assert all(p.parent == tmp_path for p in paths) and not (tmp_path.parent / "evil.dem").exists()
    assert "m1-mirage" in dl.name


def test_download_rejects_non_demo(serve, tmp_path):
    serve(b"<html>login</html>" * 10, "page.html")
    with pytest.raises(remote.RemoteError, match="démo CS2"):
        remote.download(remote.Download(id="t2", url="https://x.example/p"), tmp_path)
    assert not list(tmp_path.glob("*.dem"))


def test_import_url_api(client, monkeypatch):  # noqa: F811
    c, _ = client
    assert c.post("/api/demos/import-url", json={"url": "http://x/a.dem"}).status_code == 400
    r = c.post("/api/demos/import-url", json={"url": "https://www.faceit.com/fr/cs2/room/1-0a1b2c3d-1111-2222-3333-444455556666"})
    assert r.status_code == 400 and "Copier l'adresse du lien" in r.json()["detail"]
    assert c.get("/api/demos/remote").json() == []


from tests.test_api import client  # noqa: E402,F401  — fixture partagée


def test_hltv_links_explain_the_local_tool():
    import pytest
    from app.ingest.remote import RemoteError, check_url

    for u in ("https://www.hltv.org/matches/2398757/x", "https://r2-demos.hltv.org/demos/1/a.rar", "https://hltv.org/download/demo/1"):
        with pytest.raises(RemoteError, match="hltv-import"):
            check_url(u)
