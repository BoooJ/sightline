"""Démos demandées par un outil externe (n8n) : une ligne par (source, identifiant chez la source), créée avant le
téléchargement pour qu'un même prac ne soit jamais importé deux fois, avec l'étiquette à poser sur la démo créée.
Un échec se retente au tour suivant de l'outil ; au 3e, la démo est abandonnée et ne revient plus."""
from __future__ import annotations

import json
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.storage.models import DemoSource, MatchLabel

SOURCES = ("pracc", "faceit", "url")
MAX_ATTEMPTS = 3
KNOWN = ("downloading", "importing", "done", "abandoned")  # pas de nouvel import pour ces lignes


def clean_label(raw) -> dict:
    """Étiquette envoyée par l'outil : {folder, played_on (AAAA-MM-JJ), tags (10 au plus), opponent}."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("Étiquette invalide")
    tags = raw.get("tags") or []
    if not isinstance(tags, list) or len(tags) > 10 \
            or not all(isinstance(t, str) and 0 < len(t.strip()) <= 64 for t in tags):
        raise ValueError("Étiquettes : 10 au plus, de 1 à 64 caractères")
    played_on = str(raw.get("played_on") or "")[:10] or None
    if played_on:
        try:
            date.fromisoformat(played_on)
        except ValueError:
            raise ValueError("Date de jeu invalide (AAAA-MM-JJ)") from None
    return {"folder": str(raw.get("folder") or "").strip()[:128], "played_on": played_on,
            "tags": [t.strip() for t in tags], "opponent": str(raw.get("opponent") or "").strip()[:128]}


def known(db: Session, source: str, ids: list[str]) -> list[str]:
    rows = db.scalars(select(DemoSource.external_id).where(
        DemoSource.source == source, DemoSource.external_id.in_(ids), DemoSource.status.in_(KNOWN)))
    return sorted(set(rows))


def find(db: Session, source: str, external_id: str) -> DemoSource | None:
    return db.scalar(select(DemoSource).where(DemoSource.source == source, DemoSource.external_id == external_id))


def start(db: Session, source: str, external_id: str, label: dict) -> DemoSource:
    """Nouvelle demande, ou nouvel essai d'une demande en erreur (le compteur d'échecs est gardé)."""
    row = find(db, source, external_id)
    if row is None:
        row = DemoSource(source=source, external_id=external_id, attempts=0)
        db.add(row)
    row.status, row.error, row.label = "downloading", None, json.dumps(label, ensure_ascii=False)
    db.commit()
    return row


def set_status(sf: sessionmaker[Session], source_id: int, status: str) -> None:
    with sf() as db:
        row = db.get(DemoSource, source_id)
        if row is not None:
            row.status = status
            db.commit()


def mark_done(sf: sessionmaker[Session], source_id: int, demo_id: int, created: bool) -> None:
    """Démo reçue. L'étiquette n'est posée que sur une démo nouvelle : un doublon garde celle choisie par l'équipe."""
    with sf() as db:
        row = db.get(DemoSource, source_id)
        if row is None:
            return
        row.status, row.demo_id, row.error = "done", demo_id, None
        if created:
            apply_label(db, demo_id, json.loads(row.label or "{}"))
        db.commit()


def apply_label(db: Session, demo_id: int, label: dict) -> None:
    if not label:
        return
    lab = db.get(MatchLabel, demo_id)
    if lab is None:
        lab = MatchLabel(demo_id=demo_id, folder="", event="", tags="[]")
        db.add(lab)
    lab.folder = label.get("folder") or lab.folder
    lab.tags = json.dumps(label.get("tags") or [], ensure_ascii=False)
    if label.get("played_on"):
        lab.played_on = date.fromisoformat(label["played_on"])


def mark_failed(sf: sessionmaker[Session], source_id: int, error: str) -> None:
    with sf() as db:
        row = db.get(DemoSource, source_id)
        if row is None:
            return
        row.attempts = (row.attempts or 0) + 1
        row.status = "abandoned" if row.attempts >= MAX_ATTEMPTS else "error"
        row.error = (error or "Échec")[:500]
        db.commit()


def reset_interrupted(sf: sessionmaker[Session]) -> int:
    """Au démarrage : un téléchargement coupé par un redémarrage repasse en erreur, l'outil le reprendra."""
    with sf() as db:
        rows = db.scalars(select(DemoSource).where(DemoSource.status.in_(("downloading", "importing")))).all()
        for row in rows:
            row.status, row.error = "error", "Interrompu par un redémarrage du serveur"
        db.commit()
        return len(rows)


def origin_of_demo(db: Session, demo_id: int | None) -> dict:
    """Source, identifiant et adversaire d'une démo demandée par un outil (tout à None sinon)."""
    row = db.scalar(select(DemoSource).where(DemoSource.demo_id == demo_id).order_by(DemoSource.id.desc())) \
        if demo_id else None
    if row is None:
        return {"source": None, "external_id": None, "opponent": None}
    return {"source": row.source, "external_id": row.external_id,
            "opponent": json.loads(row.label or "{}").get("opponent") or None}
