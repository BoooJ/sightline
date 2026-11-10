# backend/app/storage/labels.py
"""Étiquettes de bibliothèque et filtres communs (dossier, événement, étiquette, période) aux pages Matchs, Rounds
et Joueurs."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.storage.models import Match


def labels_of(m: Match) -> dict:
    lab = m.demo.label if m.demo else None
    return {"folder": lab.folder if lab else "", "event": lab.event if lab else "",
            "tags": json.loads(lab.tags) if lab else [], "played_on": lab.played_on.isoformat() if lab and lab.played_on else None}


def match_date(m: Match) -> date | None:
    """Date de référence : date de jeu saisie, sinon date de la démo, sinon date d'import."""
    lab = m.demo.label if m.demo else None
    if lab and lab.played_on:
        return lab.played_on
    if m.played_at:
        return m.played_at.date()
    return m.demo.imported_at.date() if m.demo and m.demo.imported_at else None


def match_kind(m: Match) -> str:
    """« official » si un événement est renseigné ou si le dossier parle d'officiels, sinon « practice » (scrims)."""
    lab = labels_of(m)
    return "official" if lab["event"] or "offi" in lab["folder"].lower() else "practice"


KINDS = ("official", "practice")


@dataclass
class LibraryFilters:
    folder: str | None = None
    event: str | None = None
    tag: str | None = None
    date_from: date | None = None
    date_to: date | None = None
    team: int | None = None       # matchs où cette équipe joue
    kind: str | None = None       # official / practice
    months: int | None = None     # matchs des N derniers mois
    last_n: int | None = None     # seulement les N matchs les plus récents (après les autres filtres)

    def active(self) -> bool:
        return any((self.folder, self.event, self.tag, self.date_from, self.date_to, self.team, self.kind, self.months, self.last_n))

    def keep(self, m: Match) -> bool:
        lab = labels_of(m)
        if self.team and self.team not in (m.team_a_id, m.team_b_id):
            return False
        if self.kind and match_kind(m) != self.kind:
            return False
        if self.folder is not None and self.folder != "" and lab["folder"] != self.folder:
            return False
        if self.event and lab["event"] != self.event:
            return False
        if self.tag and self.tag not in lab["tags"]:
            return False
        d = match_date(m)
        if self.date_from and (d is None or d < self.date_from):
            return False
        if self.date_to and (d is None or d > self.date_to):
            return False
        if self.months and (d is None or d < date.today() - timedelta(days=round(30.44 * self.months))):
            return False
        return True


def filtered_match_ids(session: Session, f: LibraryFilters, map_name: str | None = None) -> set[int] | None:
    """Ids des matchs retenus, ou None si aucun filtre de bibliothèque n'est actif (pas de restriction)."""
    if not f.active():
        return None
    q = select(Match)
    if map_name:
        q = q.where(Match.map_name == map_name)
    kept = [m for m in session.scalars(q) if f.keep(m)]
    if f.last_n:
        kept.sort(key=lambda m: (match_date(m) or date.min, m.id), reverse=True)
        kept = kept[: f.last_n]
    return {m.id for m in kept}


def parse_filters(folder: str | None, event: str | None, tag: str | None, date_from: str | None,
                  date_to: str | None, team: int | None = None, last_n: int | None = None, kind: str | None = None,
                  months: int | None = None) -> LibraryFilters:
    """Lit les paramètres d'URL communs ; ValueError si une date ou un type est invalide."""
    p = lambda s: date.fromisoformat(s) if s else None  # noqa: E731
    if kind not in (None, "", *KINDS):
        raise ValueError("kind")
    return LibraryFilters(folder=folder, event=event, tag=tag, date_from=p(date_from), date_to=p(date_to),
                          team=team or None, last_n=max(1, last_n) if last_n else None, kind=kind or None,
                          months=max(1, months) if months else None)
