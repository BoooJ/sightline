# backend/app/ingest/remote.py
"""Import d'une démo par lien : lien direct vers une démo (.dem, .dem.gz, .dem.zst, .dem.bz2, dont le lien de
téléchargement d'une démo FACEIT), ou page de match FACEIT si une clé d'API FACEIT avec l'accès « Downloads » est
configurée (SKYBOX_FACEIT_API_KEY).

Sécurité : https uniquement, adresses publiques uniquement (y compris après redirection), taille plafonnée, et le
fichier obtenu doit être une démo CS2 (signature PBDEMS2)."""
from __future__ import annotations

import bz2
import gzip
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import zstandard as zstd

MAX_BYTES = 2 * 1024**3  # 2 Go compressés au plus
CHUNK = 4 * 1024 * 1024
FACEIT_ROOM = re.compile(r"faceit\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?(?:cs2|csgo)/room/(1-[0-9a-f-]{36})", re.I)
CS2_MAGIC = b"PBDEMS2"


class RemoteError(Exception):
    """Erreur présentée telle quelle à l'utilisateur."""


@dataclass
class Download:
    id: str
    url: str
    name: str = ""
    status: str = "downloading"  # downloading | importing | done | error
    received: int = 0
    total: int | None = None
    error: str | None = None
    demo_id: int | None = None
    demo_index: int = 0  # match FACEIT en BO3 : une démo par carte
    faceit_match: str | None = None
    started: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        host = urllib.parse.urlparse(self.url).hostname or ""
        return {"id": self.id, "host": host, "name": self.name, "status": self.status, "received": self.received,
                "total": self.total, "error": self.error, "demo_id": self.demo_id, "faceit_match": self.faceit_match}


def _public_host(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise RemoteError(f"Adresse introuvable : {host}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise RemoteError("Ce lien pointe vers une adresse privée : refusé.")


def check_url(url: str) -> str:
    url = url.strip()
    p = urllib.parse.urlparse(url)
    if p.scheme != "https" or not p.hostname:
        raise RemoteError("Lien invalide : collez une adresse qui commence par https://")
    if p.hostname == "hltv.org" or p.hostname.endswith(".hltv.org"):
        raise RemoteError("HLTV bloque les téléchargements depuis un serveur (Cloudflare) : utilisez l'outil d'import HLTV "
                          "sur votre PC (node scripts/hltv-import.mjs <lien du match>).")
    _public_host(p.hostname)
    return url


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)  # une redirection vers une adresse privée est refusée
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SafeRedirect)


def _request(url: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 60):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "Sightline/1.0", **(headers or {})})
    return _opener.open(req, timeout=timeout)


def faceit_demo_url(room_url: str, api_key: str | None, index: int = 0) -> str:
    """Lien de téléchargement signé de la démo d'un match FACEIT (API Data + API Downloads)."""
    m = FACEIT_ROOM.search(room_url)
    if not m:
        raise RemoteError("Lien FACEIT non reconnu.")
    if not api_key:
        raise RemoteError("Pour un lien de page de match FACEIT, il faut une clé d'API FACEIT sur le serveur. "
                          "Sinon : sur la page du match, clic droit sur « Télécharger la démo » → « Copier l'adresse "
                          "du lien », puis collez ce lien ici.")
    auth = {"Authorization": f"Bearer {api_key}"}
    try:
        with _request(f"https://open.faceit.com/data/v4/matches/{m.group(1)}", headers=auth, timeout=30) as r:
            match = json.load(r)
        demos = match.get("demo_url") or []
        if len(demos) <= index:
            raise RemoteError("FACEIT ne propose pas (encore) de démo pour ce match.")
        body = json.dumps({"resource_url": demos[index]}).encode()
        with _request("https://open.faceit.com/download/v2/demos/download", data=body,
                      headers={**auth, "Content-Type": "application/json"}, timeout=30) as r:
            return json.load(r)["payload"]["download_url"]
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise RemoteError("FACEIT refuse l'accès à la démo : la clé d'API doit avoir l'accès « Downloads ». "
                              "Sinon, collez directement le lien du bouton « Télécharger la démo ».")
        if e.code == 404:
            raise RemoteError("Match FACEIT introuvable.")
        raise RemoteError(f"FACEIT a répondu {e.code}.")


def _name_from(url: str, headers) -> str:
    cd = headers.get("Content-Disposition") or ""
    m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)', cd)
    name = urllib.parse.unquote(m.group(1)) if m else Path(urllib.parse.urlparse(url).path).name
    name = re.sub(r"[^\w.\-]+", "_", name)[:120] or "demo"
    return name


def download(dl: Download, dest_dir: Path, faceit_key: str | None = None) -> list[Path]:
    """Télécharge, décompresse si besoin (gz, zst ; bz2 est géré à l'analyse ; archives .zip et .rar d'HLTV, une démo
    par carte) et vérifie la signature CS2. Renvoie les démos prêtes à importer."""
    url = check_url(dl.url)
    if FACEIT_ROOM.search(url):
        url = check_url(faceit_demo_url(url, faceit_key, dl.demo_index))
    partial = dest_dir / ".partial"
    partial.mkdir(parents=True, exist_ok=True)
    raw = partial / f"url-{dl.id}.download"
    try:
        with _request(url, timeout=60) as r:
            name = _name_from(url, r.headers)
            length = r.headers.get("Content-Length")
            dl.total = int(length) if length and length.isdigit() else None
            if dl.total and dl.total > MAX_BYTES:
                raise RemoteError("Fichier trop volumineux (plus de 2 Go).")
            with open(raw, "wb") as out:
                while chunk := r.read(CHUNK):
                    dl.received += len(chunk)
                    if dl.received > MAX_BYTES:
                        raise RemoteError("Fichier trop volumineux (plus de 2 Go).")
                    out.write(chunk)
    except urllib.error.HTTPError as e:
        raise RemoteError("Lien expiré ou refusé (403) : recopiez un lien de téléchargement récent." if e.code == 403
                          else f"Le serveur distant a répondu {e.code}.")
    except urllib.error.URLError as e:
        raise RemoteError(f"Téléchargement impossible : {e.reason}")
    with open(raw, "rb") as f:
        head = f.read(8)
    if head[:4] == b"PK\x03\x04" or head[:6] == b"Rar!\x1a\x07":
        try:
            return _from_archive(raw, partial, dest_dir, dl, rar=head[:4] != b"PK\x03\x04")
        finally:
            raw.unlink(missing_ok=True)
    base = re.sub(r"\.(dem)?(\.?(gz|zst|bz2|download))*$", "", name, flags=re.I) or "demo"
    try:
        if head[:2] == b"\x1f\x8b":
            out = partial / f"{base}.dem"
            with gzip.open(raw, "rb") as src, open(out, "wb") as dst:
                _copy(src, dst)
        elif head[:4] == b"\x28\xb5\x2f\xfd":
            out = partial / f"{base}.dem"
            with open(raw, "rb") as src, open(out, "wb") as dst:
                zstd.ZstdDecompressor().copy_stream(src, dst, read_size=CHUNK, write_size=CHUNK)
        elif head[:3] == b"BZh":
            out = partial / f"{base}.dem.bz2"
            raw.replace(out)
            with bz2.open(out, "rb") as f:
                head = f.read(8)
        else:
            out = partial / f"{base}.dem"
            raw.replace(out)
    finally:
        raw.unlink(missing_ok=True)
    if not out.name.endswith(".bz2"):
        with open(out, "rb") as f:
            head = f.read(8)
    if not head.startswith(CS2_MAGIC):
        out.unlink(missing_ok=True)
        raise RemoteError("Ce lien ne mène pas à une démo CS2.")
    final = _place(out, dest_dir)
    dl.name = final.name
    return [final]


def _place(out: Path, dest_dir: Path) -> Path:
    final = dest_dir / out.name
    if final.exists():
        final = dest_dir / f"{final.name.split('.')[0]}-{secrets.token_hex(3)}{''.join(final.suffixes)}"
    out.replace(final)
    return final


def _from_archive(raw: Path, partial: Path, dest_dir: Path, dl: Download, rar: bool) -> list[Path]:
    """Démos CS2 contenues dans une archive (une par carte pour une série HLTV)."""
    work = partial / f"arch-{dl.id}"
    work.mkdir(exist_ok=True)
    try:
        if rar:
            tool = shutil.which("bsdtar") or shutil.which("tar")
            if not tool:
                raise RemoteError("Archives .rar non prises en charge sur ce serveur.")
            res = subprocess.run([tool, "-xf", str(raw), "-C", str(work)], capture_output=True, timeout=1800)
            if res.returncode != 0:
                raise RemoteError("Archive .rar illisible.")
        else:
            with zipfile.ZipFile(raw) as z:
                if sum(i.file_size for i in z.infolist()) > 8 * MAX_BYTES:
                    raise RemoteError("Archive trop volumineuse une fois décompressée.")
                for info in z.infolist():
                    if info.filename.lower().endswith(".dem") and not info.is_dir():
                        target = work / Path(info.filename).name  # aplati : pas de chemins relatifs dans l'archive
                        with z.open(info) as src, open(target, "wb") as dst:
                            _copy(src, dst)
        demos = []
        for f in sorted(work.rglob("*.dem")):
            with open(f, "rb") as h:
                ok = h.read(8).startswith(CS2_MAGIC)
            if ok:
                demos.append(_place(f, dest_dir))
        if not demos:
            raise RemoteError("Aucune démo CS2 dans cette archive.")
        dl.name = ", ".join(d.name for d in demos)
        return demos
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _copy(src, dst) -> None:
    total = 0
    while chunk := src.read(CHUNK):
        total += len(chunk)
        if total > 4 * MAX_BYTES:
            raise RemoteError("Démo décompressée trop volumineuse.")
        dst.write(chunk)


def faceit_key(data_dir: Path | None = None) -> str | None:
    """Clé d'API FACEIT : variable d'environnement, sinon clé saisie dans l'app (page Scouting FACEIT)."""
    if data_dir is None:
        return os.environ.get("SKYBOX_FACEIT_API_KEY") or os.environ.get("FACEIT_API_KEY") or None
    from app.faceit.client import api_key
    return api_key(data_dir)[0]
