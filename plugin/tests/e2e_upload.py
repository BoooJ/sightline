"""Bout en bout du plugin sans TeamSpeak : le harnais sightline_fake_session fabrique une session (deux voix
synthétiques, deux rounds GSI) et l'envoie, par le même code que la DLL, à un Sightline local lancé sur un dossier
de données jetable avec une clé de portée « comms ». Vérifie ensuite ce que le serveur a reçu et rangé.

Usage (depuis la racine du dépôt) :
  backend/.venv/Scripts/python.exe plugin/tests/e2e_upload.py plugin/build/win32/Release/sightline_fake_session.exe
"""
from __future__ import annotations

import array
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.integrations.comms import clean_session  # noqa: E402


def free_port() -> int:
    """Port éphémère libre : jamais un serveur déjà lancé (par exemple une instance de développement)."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,channels",
                          "-show_entries", "format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def pcm(path: Path) -> array.array:
    """Piste décodée par libopus (le décodeur des navigateurs), 48 kHz mono 16 bits ; la moindre erreur = échec."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-err_detect", "crccheck", "-c:a", "libopus", "-i", str(path),
                          "-f", "s16le", "-ac", "1", "-ar", "48000", "-"], capture_output=True, check=True)
    assert not out.stderr.strip(), out.stderr.decode(errors="replace")
    a = array.array("h")
    a.frombytes(out.stdout)
    return a


def loud(a: array.array, start: float, end: float) -> bool:
    seg = a[int(start * 48000):int(end * 48000)]
    return len(seg) > 0 and max(abs(x) for x in seg) > 2000


def first_loud(a: array.array) -> float:
    return next(i for i, x in enumerate(a) if abs(x) > 2000) / 48000


def main(exe: str) -> None:
    assert shutil.which("ffprobe") and shutil.which("ffmpeg"), "ffmpeg requis (winget install Gyan.FFmpeg)"
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    try:
        httpx.get(base + "/api/health", timeout=2)
    except httpx.HTTPError:
        pass
    else:
        raise AssertionError(f"un serveur répond déjà sur le port {port}")
    with tempfile.TemporaryDirectory(prefix="sightline-e2e-", ignore_cleanup_errors=True) as tmp:
        tmp = Path(tmp)
        env = {**os.environ, "SKYBOX_DATA_DIR": str(tmp / "data"), "SKYBOX_CONFIG": str(tmp / "config.toml")}
        server = subprocess.Popen([str(ROOT / "backend/.venv/Scripts/python.exe"), "-m", "uvicorn",
                                   "app.main:get_app", "--factory", "--host", "127.0.0.1", "--port", str(port)],
                                  cwd=ROOT / "backend", env=env)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError(f"le serveur s'est arrêté (code {server.returncode}) avant d'être prêt")
                try:
                    if httpx.get(base + "/api/health").status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(0.3)
            else:
                raise RuntimeError("le serveur local n'a pas répondu en 30 s")
            c = httpx.Client(base_url=base, timeout=30)
            assert c.post("/api/auth/setup", json=OWNER).status_code == 200  # 127.0.0.1 : sans code d'installation
            key = c.post("/api/integrations/keys", json={"name": "plugin e2e", "scopes": ["comms"]}).json()["key"]
            run = subprocess.run([str(Path(exe).resolve()), str(tmp / "plugin"), base, key],
                                 capture_output=True, text=True, encoding="utf-8", timeout=120)
            print(run.stdout, run.stderr)
            assert run.returncode == 0, "le harnais n'a pas pu envoyer la session"
            # côté plugin : session marquée envoyée, session.json conforme au contrat du serveur
            [folder] = list((tmp / "plugin" / "sessions").iterdir())
            assert (folder / "sent.json").exists()
            raw = json.loads((folder / "session.json").read_text(encoding="utf-8"))
            assert raw["started_at"].endswith("Z") and raw["plugin"] == "1.0.0"
            s = clean_session(raw, {"t1.ogg", "t2.ogg"})
            assert [r["n"] for r in s["rounds"]] == [1, 2] and s["score"] == [1, 1] and s["map"] == "de_nuke"
            assert s["recorder_steamid"] == "76561198000000001"
            assert [(t["ts_nickname"], t["self"]) for t in s["tracks"]] == [("sk1zy", True), ("Invité", False)]
            first = datetime.fromisoformat(s["rounds"][0]["live_at"]) - datetime.fromisoformat(s["started_at"])
            assert abs(first.total_seconds() - 1.0) < 0.002
            # côté serveur : session reçue, en attente de sa démo, pistes gardées telles quelles
            [row] = c.get("/api/integrations/comms").json()["sessions"]
            assert row["status"] == "waiting" and row["map"] == "de_nuke" and row["tracks"] == 2, row
            [stored] = list((tmp / "data" / "comms").iterdir())
            t1, t2 = stored / "t1.ogg", stored / "t2.ogg"
            for t in (t1, t2):
                p = probe(t)
                assert p["streams"][0]["codec_name"] == "opus" and p["streams"][0]["channels"] == 1, p
                assert abs(float(p["format"]["duration"]) - 13.0) < 0.05, p  # chaque piste : de A0 à la fin
            a, b = pcm(t1), pcm(t2)
            assert abs(len(a) / 48000 - 13.0) < 0.05 and abs(len(b) / 48000 - 13.0) < 0.05
            assert abs(first_loud(a) - 1.0) < 0.05, first_loud(a)  # calées sur A0
            assert abs(first_loud(b) - 5.0) < 0.05, first_loud(b)
            assert loud(a, 1.1, 2.9) and not loud(a, 3.2, 9.8) and loud(a, 10.1, 11.9) and not loud(a, 12.2, 13.0)
            assert not loud(b, 0.0, 4.9) and loud(b, 5.1, 6.9) and not loud(b, 7.2, 13.0)
            print("bout en bout : OK")
        finally:
            # python.exe du venv n'est qu'un lanceur : tuer tout l'arbre, sinon le vrai serveur reste sur le port
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(server.pid)], capture_output=True)
            try:
                server.wait(10)
            except subprocess.TimeoutExpired:
                pass


if __name__ == "__main__":
    main(sys.argv[1])
