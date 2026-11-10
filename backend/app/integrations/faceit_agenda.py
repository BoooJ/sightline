"""Nos matchs FACEIT à venir (ESEA…) pour le calendrier, lus depuis le serveur (n8n W6 → Sightline, toutes les 15 min).

Notre équipe est celle où jouent le plus de comptes du site liés (Steam ID), retrouvée dans leurs historiques FACEIT, avec
ses championnats récents. Leurs matchs à venir ou en cours donnent l'horaire exact, que FACEIT déplace souvent : la
synchro (app.integrations.agenda) le suit. Un championnat où l'équipe n'a encore rien joué (les playoffs, la saison
suivante) n'est vu qu'après son premier match : PRACC, qui recopie aussi ces matchs, sert de secours d'ici là."""
from __future__ import annotations

import time
from datetime import datetime, timezone

from app.faceit.client import FaceitClient, FaceitError
from app.faceit.scout import is_esea

FRESH = 300  # matchs d'un championnat : relus à chaque passage de W6, un horaire changé est vu dans le quart d'heure
PLAYER = 6 * 3600
RECENT = 60 * 86400  # championnats joués ces 60 derniers jours : la saison en cours, pas les anciennes
MAX_COMPS = 5
PAGE = 100


def _player_id(c: FaceitClient, steamid: str) -> str | None:
    try:
        return c.get("/players", {"game": "cs2", "game_player_id": steamid}, ttl=PLAYER).get("player_id")
    except FaceitError as e:
        if e.status == 404:
            return None  # pas de compte FACEIT pour ce Steam ID
        raise


def our_team(c: FaceitClient, steamids: set[str], now: float) -> tuple[str, str, list[str]] | None:
    """(id, nom, championnats récents) de l'équipe où jouent le plus de joueurs liés dans des matchs de championnat
    (à égalité, celle qui a joué le plus récemment) ; None si aucun n'en a joué."""
    players: dict[str, set[str]] = {}
    names: dict[str, str] = {}
    comps: dict[str, dict[str, float]] = {}
    for pid in sorted({p for p in (_player_id(c, s) for s in sorted(steamids)) if p}):
        for it in c.get(f"/players/{pid}/history", {"game": "cs2", "offset": 0, "limit": 100}).get("items", []):
            if (it.get("competition_type") or "").lower() != "championship" or not it.get("competition_id"):
                continue
            for f in (it.get("teams") or {}).values():
                tid = (f or {}).get("team_id")
                if not tid or pid not in {p.get("player_id") for p in f.get("players") or []}:
                    continue
                players.setdefault(tid, set()).add(pid)
                names[tid] = names.get(tid) or f.get("nickname") or ""
                played = comps.setdefault(tid, {})
                when = float(it.get("finished_at") or it.get("started_at") or 0)
                played[it["competition_id"]] = max(played.get(it["competition_id"], 0.0), when)
    if not players:
        return None
    tid = max(players, key=lambda t: (len(players[t]), max(comps[t].values())))
    recent = sorted((cid for cid, t in comps[tid].items() if now - t <= RECENT), key=lambda cid: -comps[tid][cid])
    return tid, names[tid], recent[:MAX_COMPS]


def _event(m: dict, team_id: str) -> dict:
    them = next((t for t in ((t or {}) for t in (m.get("teams") or {}).values()) if t.get("faction_id") != team_id), {})
    opponent = str(them.get("name") or "").strip()
    comp = str(m.get("competition_name") or "")
    room = str(m.get("faceit_url") or "").replace("{lang}", "fr")
    return {"external_id": m["match_id"], "kind": "match", "opponent_id": them.get("faction_id"),
            "title": f"{'ESEA' if is_esea(comp) else 'FACEIT'} vs. {opponent or '?'}", "opponent": opponent,
            "starts_at": datetime.fromtimestamp(m["scheduled_at"], timezone.utc).isoformat(),
            "notes": "\n".join(x for x in (comp, f"BO{m['best_of']}" if m.get("best_of") else "", room) if x)}


def upcoming(c: FaceitClient, steamids: set[str], now: float | None = None) -> dict:
    """{team, team_id, events} : nos matchs de championnat à venir ou en cours (avec l'id FACEIT de l'adversaire).
    `events` vaut None quand on ne sait rien (équipe introuvable, aucun championnat récent) : le calendrier n'est alors
    pas touché, plutôt que vidé à tort."""
    team = our_team(c, steamids, time.time() if now is None else now)
    if team is None or not team[2]:
        return {"team": team[1] if team else None, "team_id": team[0] if team else None, "events": None}
    tid, name, comps = team
    found: dict[str, dict] = {}
    for cid in comps:
        for kind in ("upcoming", "ongoing"):  # en cours : un match lancé avant l'heure prévue ne doit pas disparaître
            for offset in range(0, 1000, PAGE):
                try:
                    items = c.get(f"/championships/{cid}/matches", {"type": kind, "offset": offset, "limit": PAGE},
                                  ttl=FRESH).get("items", [])
                except FaceitError as e:
                    if e.status == 404:
                        break  # championnat retiré
                    raise
                for m in items:
                    ours = tid in {(t or {}).get("faction_id") for t in (m.get("teams") or {}).values()}
                    if ours and m.get("match_id") and isinstance(m.get("scheduled_at"), (int, float)):
                        found[m["match_id"]] = _event(m, tid)
                if len(items) < PAGE:
                    break
    return {"team": name, "team_id": tid, "events": list(found.values())}
