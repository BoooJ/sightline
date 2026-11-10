"""Import en bloc de stratégies et d'entrées du mémo (export d'un stratbook tenu ailleurs, Google Sheet…).
Chaque élément passe par les mêmes contrôles que l'API ; une stratégie déjà présente (même carte, camp et nom) ou une
entrée du mémo identique (même genre, titre, carte et camp) est laissée telle quelle : l'import se relance sans doublon.
Usage (dans le conteneur) : python -m app.stratbook_import fichier.json"""
import json
import sys

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.api import playbook as playbook_api
from app.api.strats import _clean_body
from app.storage.models import PlaybookEntry, Strat

STRAT_DEFAULTS = {"type": "other", "description": "", "tags": "[]", "positions": "[]", "grenades": "[]", "shapes": "[]",
                  "roles": "[]", "links": "[]"}


def _obj(item) -> dict:
    if not isinstance(item, dict):
        raise HTTPException(400, "élément invalide (objet attendu)")
    return item


def _label(item, key: str):
    return item.get(key) if isinstance(item, dict) else None


def import_data(sf: sessionmaker[Session], data: dict) -> dict:
    report = {"strats_created": 0, "strats_skipped": 0, "playbook_created": 0, "playbook_skipped": 0, "errors": []}
    with sf() as db:
        known = {(s.map_name, s.side, s.name.lower()) for s in db.scalars(select(Strat))}
        for i, item in enumerate(data.get("strats") or []):
            try:
                clean = _clean_body(_obj(item), partial=False)
            except (HTTPException, TypeError, ValueError, AttributeError) as e:
                report["errors"].append(f"stratégie {i + 1} ({_label(item, 'name')}) : {getattr(e, 'detail', e)}")
                continue
            key = (clean["map_name"], clean["side"], clean["name"].lower())
            if key in known:
                report["strats_skipped"] += 1
                continue
            db.add(Strat(**{**STRAT_DEFAULTS, **clean}))
            known.add(key)
            report["strats_created"] += 1
        seen = {(e.kind, e.title.lower(), e.map_name, e.side) for e in db.scalars(select(PlaybookEntry))}
        for i, item in enumerate(data.get("playbook") or []):
            try:
                clean = playbook_api._clean(_obj(item), partial=False)
            except (HTTPException, TypeError, ValueError, AttributeError) as e:
                report["errors"].append(f"mémo {i + 1} ({_label(item, 'title')}) : {getattr(e, 'detail', e)}")
                continue
            key = (clean["kind"], clean["title"].lower(), clean.get("map_name"), clean.get("side"))
            if key in seen:
                report["playbook_skipped"] += 1
                continue
            db.add(PlaybookEntry(**{"body": "", "position": 0, **clean}))
            seen.add(key)
            report["playbook_created"] += 1
        db.commit()
    return report


def main(path: str) -> None:
    from app.core.config import load_settings
    from app.core.db import make_engine, make_session_factory
    settings = load_settings()
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    report = import_data(make_session_factory(make_engine(settings.db_url)), data)
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
