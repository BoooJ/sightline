"""Intégrations avec des outils externes (n8n…) : clés d'API, démos demandées par identifiant, webhooks sortants.
N'importe rien de app.auth : app.auth.core → app.api.deps → ImportService, qui émet les événements d'ici."""
from __future__ import annotations

from datetime import UTC, datetime


def utcnow() -> datetime:
    """UTC naïf, comme le reste de la base (SQLite ne stocke pas les fuseaux)."""
    return datetime.now(UTC).replace(tzinfo=None)


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None
