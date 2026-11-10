# backend/app/api/deps.py
from collections.abc import Iterator

import orjson
from fastapi import Response, Request
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.ingest.service import ImportService


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as s:
        yield s


def get_service(request: Request) -> ImportService:
    return request.app.state.service


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def big_json(data) -> Response:
    """Réponse JSON volumineuse (histoires de rounds, grenades, moments forts) : sérialisée d'un coup par orjson,
    sans la relecture générique de FastAPI qui coûte des centaines de millisecondes sur quelques centaines de Ko."""
    return Response(content=orjson.dumps(data), media_type="application/json")


def lib_filters(folder: str | None = None, event: str | None = None, tag: str | None = None, date_from: str | None = None,
                date_to: str | None = None, team: int | None = None, last_n: int | None = None, kind: str | None = None,
                months: int | None = None):
    """Filtres de bibliothèque communs à toutes les pages (dossier, événement, étiquette, période, équipe, N derniers
    matchs, officiel / entraînement, derniers mois), lus dans la requête."""
    from fastapi import HTTPException

    from app.storage.labels import parse_filters
    try:
        return parse_filters(folder, event, tag, date_from, date_to, team, last_n, kind, months)
    except ValueError:
        raise HTTPException(400, "Filtre invalide (date AAAA-MM-JJ, type official ou practice)")


def lib_key(lib) -> tuple:
    """Clé de cache d'un jeu de filtres."""
    from dataclasses import astuple
    return astuple(lib)
