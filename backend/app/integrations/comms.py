"""Comms TeamSpeak envoyées par le plugin Sightline : une piste Opus par voix entendue (plus le micro de l'enregistreur)
et les débuts des rounds lus par la Game State Integration de CS2, à l'horloge du PC. Sightline les rattache au match
de la même map, calcule le décalage avec la démo et range chaque piste sous son joueur (pseudo TeamSpeak du compte).
Spec : docs/superpowers/specs/2026-10-24-comms-teamspeak-design.md."""
from __future__ import annotations

import json
import logging
import re
import shutil
import statistics
import threading
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.notify import notify
from app.integrations import iso, utcnow, webhooks
from app.storage.models import CommsSession, Demo, Match, MatchAudio, MatchPlayer, Round, User

MAX_TRACKS = 12
MAX_BYTES = 200 * 1024 * 1024
MAX_ROUNDS = 60
MULTIPART_SLACK = 1024 * 1024  # surcoût du multipart au-dessus de MAX_BYTES (en-têtes, champ session)
CHUNK = 1024 * 1024
SKEW = timedelta(minutes=10)   # décalage d'horloge PC / serveur toléré : une démo n'existe qu'après la fin de sa map
WAIT = timedelta(hours=48)     # une session attend sa démo deux jours au plus
OUTLIER_S = 2.0                # round écarté s'il s'éloigne de plus de 2 s de la médiane
_MAP = re.compile(r"[a-z0-9_]{2,64}")


def _when(v) -> datetime:
    """Date ISO 8601 avec fuseau (« Z » accepté) → UTC sans fuseau, comme en base."""
    d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    if d.tzinfo is None:
        raise ValueError("date sans fuseau")
    return d.astimezone(timezone.utc).replace(tzinfo=None)


def clean_session(raw: dict, files: set[str]) -> dict:
    """session.json du plugin, validé ; `files` : noms des fichiers reçus avec. ValueError avec la raison sinon."""
    if not isinstance(raw, dict):
        raise ValueError("session.json invalide")
    try:
        started = _when(raw["started_at"])
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError("started_at : date ISO avec fuseau attendue") from e
    map_name = str(raw.get("map") or "")
    if not _MAP.fullmatch(map_name):
        raise ValueError("map invalide")
    sid = str(raw.get("recorder_steamid") or "")
    if sid and not (sid.isascii() and sid.isdigit()):
        raise ValueError("recorder_steamid invalide")
    score = raw.get("score")
    if score is not None and not (isinstance(score, list) and len(score) == 2
                                  and all(isinstance(x, int) and not isinstance(x, bool) and 0 <= x <= 99
                                          for x in score)):
        raise ValueError("score : deux entiers")
    raw_rounds = raw.get("rounds") or []
    if not isinstance(raw_rounds, list):
        raise ValueError("rounds : liste attendue")
    rounds = []
    for r in raw_rounds[:MAX_ROUNDS]:
        try:
            rounds.append({"n": int(r["n"]), "live_at": _when(r["live_at"]).isoformat(),
                           "over_at": _when(r["over_at"]).isoformat() if r.get("over_at") else None})
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError("rounds : n et live_at attendus") from e
    tracks = raw.get("tracks")
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= MAX_TRACKS:
        raise ValueError(f"tracks : 1 à {MAX_TRACKS} pistes")
    out = []
    for t in tracks:
        if not isinstance(t, dict):
            raise ValueError("tracks : objets attendus")
        f = str(t.get("file") or "")
        if f not in files:
            raise ValueError(f"piste sans fichier : {f or '?'}")
        out.append({"file": f, "ts_uid": str(t.get("ts_uid") or "")[:64],
                    "ts_nickname": str(t.get("ts_nickname") or "?")[:64], "self": bool(t.get("self"))})
    return {"plugin": str(raw.get("plugin") or "")[:16], "recorder_steamid": sid[:20] or None,
            "started_at": started.isoformat(), "map": map_name, "score": score, "rounds": rounds, "tracks": out}


def _round_offsets(started_at: datetime, rounds: list[dict], demo_starts: dict[int, float]) -> list[float]:
    """Décalage de chaque round présent dans la démo : (début du round à l'horloge du PC − début de l'enregistrement)
    − début du round dans la démo."""
    return [(datetime.fromisoformat(r["live_at"]) - started_at).total_seconds() - demo_starts[r["n"]]
            for r in rounds if r["n"] in demo_starts]


def _demo_starts(db: Session, match: Match) -> dict[int, float]:
    return {r.number: r.freeze_end_tick / match.demo_tickrate
            for r in db.scalars(select(Round).where(Round.match_id == match.id))}


def _rounds_coherent(started: datetime, rounds: list[dict], starts: dict[int, float]) -> bool:
    """Faux si la session et la démo ont au moins 3 rounds en commun et que moins de la moitié des décalages
    restent à 2 s de leur médiane (mauvais match, ou rounds renumérotés)."""
    cands = _round_offsets(started, rounds, starts)
    if len(cands) < 3:
        return True
    med = statistics.median(cands)
    return sum(abs(x - med) <= OUTLIER_S for x in cands) * 2 >= len(cands)


def compute_offset(started_at: datetime, rounds: list[dict], demo_starts: dict[int, float]) -> float | None:
    """Décalage des pistes (temps audio = temps démo + décalage) : médiane des décalages par round, sans les rounds
    à plus de 2 s d'elle (message GSI en retard, horloge réglée en pleine map)."""
    cands = _round_offsets(started_at, rounds, demo_starts)
    if not cands:
        return None
    med = statistics.median(cands)
    kept = [x for x in cands if abs(x - med) <= OUTLIER_S]
    return round(statistics.median(kept or [med]), 3)  # tous écartés (ex. deux rounds très éloignés) : médiane de tous


def find_match(db: Session, s: dict) -> Match | None:
    """Le match de la session : même carte ; même score (dans un ordre ou l'autre) si connu ; l'enregistreur parmi les
    joueurs s'il est connu ; démo arrivée entre 10 min avant le début de l'enregistrement (décalage d'horloge) et 48 h
    après ; pas déjà rattaché à d'autres comms ; rounds cohérents avec la session. Le plus proche APRÈS le début
    l'emporte (une démo plus ancienne est le prac d'avant)."""
    started = datetime.fromisoformat(s["started_at"])
    taken = set(db.scalars(select(CommsSession.match_id).where(CommsSession.status == "attached")))
    best: tuple[float, Match] | None = None
    for m, d in db.execute(select(Match, Demo).join(Demo, Demo.id == Match.demo_id).where(Match.map_name == s["map"])):
        # Date d'arrivée de la démo, en UTC comme started_at (created_at vient de la base) ; imported_at est à l'heure
        # locale du serveur, donc inutilisable ici.
        when = d.created_at
        if when is None or not started - SKEW <= when <= started + WAIT or m.id in taken:
            continue
        if s.get("score") and sorted([m.score_a, m.score_b]) != sorted(s["score"]):
            continue
        if s.get("recorder_steamid") and s["recorder_steamid"] not in set(
                db.scalars(select(MatchPlayer.steamid).where(MatchPlayer.match_id == m.id))):
            continue
        if not _rounds_coherent(started, s.get("rounds") or [], _demo_starts(db, m)):
            continue
        gap = max(0.0, (when - started).total_seconds())  # l'écart négatif (horloges) compte pour 0
        if best is None or gap < best[0]:
            best = (gap, m)
    return best[1] if best else None


def _norm(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").strip().lower()


def steamid_for(db: Session, nickname: str) -> str | None:
    """SteamID du membre dont le pseudo TeamSpeak (compte Sightline) est celui de la piste."""
    want = _norm(nickname)
    if not want:
        return None
    for u in db.scalars(select(User).where(User.ts_nickname.is_not(None), User.steamid.is_not(None))):
        if _norm(u.ts_nickname or "") == want:
            return u.steamid
    return None


def attach(db: Session, row: CommsSession, match: Match, audio_dir: Path) -> list[MatchAudio]:
    """Une piste match_audio par piste de la session, toutes au même décalage ; la session devient « attached ».
    Les fichiers sont DÉPLACÉS dans le dossier des pistes audio (`settle` supprime le dossier de la session après le
    commit). `row` doit déjà être flushée (on utilise row.id). Fichiers et SteamID sont traités avant tout db.add,
    pour ne pas garder le verrou d'écriture pendant les déplacements."""
    s = json.loads(row.payload)
    offset = compute_offset(datetime.fromisoformat(s["started_at"]), s["rounds"], _demo_starts(db, match))
    audio_dir.mkdir(parents=True, exist_ok=True)
    moved: list[tuple[Path, Path]] = []
    plan = []
    try:
        for i, t in enumerate(s["tracks"]):
            src = Path(row.folder) / t["file"]
            dest = audio_dir / f"{match.demo_id}-comms{row.id}-{i}{src.suffix.lower() or '.ogg'}"
            shutil.move(src, dest)
            moved.append((src, dest))
            plan.append((t, dest, steamid_for(db, t["ts_nickname"])))
    except BaseException:
        for src, dest in moved:  # la session garde ses fichiers pour le prochain essai
            shutil.move(dest, src)
        raise
    made = []
    # Sans round en commun (pas de GSI) : décalage inconnu (None sur la session), pistes à 0 s, calées à la main au replay.
    for t, dest, sid in plan:
        a = MatchAudio(demo_id=match.demo_id, label=t["ts_nickname"][:64], file_name=t["file"], path=str(dest),
                       offset_s=offset or 0.0, steamid=sid)
        db.add(a)
        made.append(a)
    row.status, row.match_id, row.offset_s, row.error = "attached", match.id, offset, None
    return made


log = logging.getLogger(__name__)
_settle_lock = threading.Lock()  # un seul rattachement à la fois : la réception et les relances d'import se croisent
EXPIRED = "Aucun match trouvé en 48 h (carte, score, joueurs)"


def as_dict(row: CommsSession) -> dict:
    s = json.loads(row.payload or "{}")
    status, error = row.status, row.error
    if status == "waiting" and row.created_at and utcnow() - row.created_at > WAIT:  # sans écrire en base (GET)
        status, error = "expired", EXPIRED
    return {"id": row.id, "status": status, "map": row.map_name, "started_at": iso(row.started_at),
            "match_id": row.match_id, "offset_s": row.offset_s, "tracks": len(s.get("tracks") or []),
            "error": error, "created_at": iso(row.created_at)}


def settle(state, session_id: int) -> None:
    """Rattache la session si son match est là ; prévient l'équipe (cloche) et les webhooks (`comms.ready`).
    Ne lève jamais : appelée après la réception et après chaque import."""
    try:
        with _settle_lock, state.session_factory() as db:
            row = db.get(CommsSession, session_id)
            if row is None or row.status != "waiting":
                return
            if row.created_at and utcnow() - row.created_at > WAIT:
                row.status, row.error = "expired", EXPIRED
                db.commit()
                shutil.rmtree(row.folder, ignore_errors=True)
                return
            m = find_match(db, json.loads(row.payload))
            if m is None:
                return
            back: list[tuple[Path, Path]] = []  # (pistes déplacées, place d'origine) si le commit échoue
            try:
                made = attach(db, row, m, state.settings.data_dir / "audio")
                back = [(Path(a.path), Path(row.folder) / a.file_name) for a in made]
                db.commit()
            except Exception:  # noqa: BLE001 — reste en attente (nouvelle tentative au prochain import)
                db.rollback()
                log.exception("comms : rattachement de la session %s", session_id)  # le détail reste au journal
                for dest, src in back:  # commit raté après le déplacement : les pistes reviennent dans la session
                    try:
                        shutil.move(dest, src)
                    except OSError:
                        log.exception("comms : remise en place de %s", src.name)
                row = db.get(CommsSession, session_id)
                row.error = "Rattachement impossible, nouvel essai au prochain import"
                db.commit()
                return
            shutil.rmtree(row.folder, ignore_errors=True)
            title = f"{m.team_a.name} {m.score_a}–{m.score_b} {m.team_b.name}"
            how = "calées sur la démo" if row.offset_s is not None else "à caler à la main dans le replay"
            notify(db, "comms", f"Comms ajoutées : {title}", f"{len(made)} piste(s) TeamSpeak, {how}",
                   f"/matches/{m.id}", bus=state.bus, settings=state.settings)
            webhooks.emit(state.session_factory, "comms.ready", {
                "match_id": m.id, "title": title, "map": m.map_name, "tracks": len(made), "offset_s": row.offset_s,
                "path": f"/matches/{m.id}"})
    except Exception:  # noqa: BLE001 — une session mal formée ne doit jamais casser un import
        log.exception("comms : session %s", session_id)


def retry_waiting(state, match_id: int | None = None) -> int:
    """Sessions en attente (de la carte du match importé, ou toutes) : nouvelle tentative de rattachement."""
    with state.session_factory() as db:
        q = select(CommsSession.id).where(CommsSession.status == "waiting")
        if match_id is not None:
            m = db.get(Match, match_id)
            if m is None:
                return 0
            q = q.where(CommsSession.map_name == m.map_name)
        ids = list(db.scalars(q))
    for sid in ids:
        settle(state, sid)
    return len(ids)
