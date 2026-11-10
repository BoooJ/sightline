# backend/app/ai/assistant.py
"""Assistant IA (Claude ou Gemini) : répond en français aux questions sur les démos de la bibliothèque.

Il ne voit pas la base directement : il interroge l'API de Sightline en lecture seule (outil `sightline_api`, liste
blanche de routes GET), en se faisant passer pour l'utilisateur connecté (mêmes droits, même cookie). Les réponses de
l'API sont compactées et tronquées pour tenir dans le contexte.

Configuration : clé API Anthropic (SKYBOX_ANTHROPIC_API_KEY) ou Google Gemini (SKYBOX_GEMINI_API_KEY), ou saisie par un
administrateur dans l'app (fichier data/secrets.json, lisible par le seul service, jamais renvoyée au navigateur). Le
fournisseur suit le modèle choisi."""
from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import AsyncIterator
from pathlib import Path

import httpx

from app.core.secrets import read_secrets, write_secrets

MODELS = {
    "gemini-flash-latest": "Gemini Flash (rapide, quota gratuit Google)",
    "gemini-pro-latest": "Gemini Pro (plus précis, facturation Google requise)",
    "gemini-flash-lite-latest": "Gemini Flash-Lite (le plus rapide)",
    "claude-opus-5-5": "Claude Opus 5.5 (le plus précis)",
    "claude-sonnet-5-5": "Claude Sonnet 5.5 (rapide, moins cher)",
    "claude-haiku-5-5": "Claude Haiku 5.5 (très rapide, le moins cher)",
}
DEFAULT_MODEL = {"anthropic": "claude-opus-5-5", "gemini": "gemini-flash-latest"}
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta"
FALLBACK_GEMINI = "gemini-flash-lite-latest"


def provider_of(model: str) -> str:
    return "gemini" if model.startswith(("gemini", "gemma")) else "anthropic"


def provider_of_key(key: str) -> str:
    return "anthropic" if key.startswith("sk-ant-") else "gemini"
MAX_STEPS = 10           # appels d'outils au plus par question
MAX_RESULT_CHARS = 10000  # taille d'une réponse d'API transmise au modèle
MAX_TOKENS = 4096

# routes GET autorisées (expressions régulières sur le chemin)
ALLOWED = [
    r"/api/matches", r"/api/matches/facets", r"/api/matches/\d+", r"/api/matches/\d+/stats", r"/api/matches/\d+/analysis",
    r"/api/players", r"/api/players/extras", r"/api/players/roles", r"/api/players/\d{5,20}", r"/api/players/\d{5,20}/dashboard",
    r"/api/teams", r"/api/rounds/search", r"/api/rounds/weapons",
    r"/api/scouting/teams", r"/api/scouting/teams/\d+", r"/api/scouting/teams/\d+/playbook", r"/api/scouting/teams/\d+/utility",
    r"/api/scouting/teams/\d+/timings", r"/api/scouting/teams/\d+/brief", r"/api/scouting/teams/\d+/facts", r"/api/scouting/routine", r"/api/scouting/story", r"/api/scouting/teams/\d+/report", r"/api/scouting/veto", r"/api/scouting/learn",
    r"/api/highlights", r"/api/callouts", r"/api/maps", r"/api/strats", r"/api/strats/\d+", r"/api/bookmarks",
    r"/api/faceit/teams", r"/api/faceit/teams/[0-9a-f-]{36}",
]
_ALLOWED_RE = [re.compile(f"^{p}$") for p in ALLOWED]

API_GUIDE = """Routes (GET, paramètres en query string) :
- /api/matches?map=de_mirage&q=texte : matchs de la bibliothèque (id, carte, équipes, score, date, événement, étiquettes).
- /api/matches/{id} : détail d'un match avec la liste des rounds (numéro, vainqueur, camps, achats, fin).
- /api/matches/{id}/stats?side=CT|T : tableau des joueurs du match (kills, morts, ADR, KAST, rating, HS…).
- /api/matches/{id}/analysis : analyse du match (probabilité de victoire par round, morts avec leur raison, visée, utilitaires).
- /api/players?map=&side=CT|T&econ=buy|eco|vs_eco|pistol : statistiques de carrière de tous les joueurs (steamid, nom, équipe, rôle…).
- /api/players/{steamid}?map=&side= : fiche détaillée d'un joueur. /api/players/{steamid}/dashboard : tableau de bord perso (dernier match, axes de progrès).
- /api/players/extras?map= : impact, morts évitables, utilitaires non utilisés, raisons des morts, visée, par joueur.
- /api/teams : équipes (id, nom, nombre de matchs).
- /api/rounds/search : recherche de rounds. Paramètres : map, team (id), opponent (id), side (CT|T, du point de vue de team), result (won|lost),
  bomb (planted|none|A|B), half (first|second|ot), buy et opp_buy (pistol,eco,semi,force,full ; liste séparée par des virgules),
  match (id), weapon, quick (second,opening_won,opening_lost,clutch_won,eco_won,commented,annotated), tactic (t:execute[:A|B], ct:<placement>), limit.
  Renvoie les rounds (match, numéro, camps, achats, vainqueur, fin, kills…) et un total.
- /api/scouting/teams : équipes à scouter. /api/scouting/teams/{id} : rapport (cartes, sites, joueurs, forme).
- /api/scouting/teams/{id}/playbook?map= : tactiques T détectées (execute, rush, split… par site ; fin des defaults : puis exécution, puis prise, aux duels, sans prise ; prise du site et rotation CT provoquée) et placements CT, avec rounds.
- /api/scouting/teams/{id}/utility?map= : lineups de l'équipe. /api/scouting/teams/{id}/timings?map=&side=T|CT : arrivées par zone.
- /api/scouting/teams/{id}/brief?map= : brief d'une carte (pistols T/CT et ce qu'ils y jouent, round après pistol, premier gun round,
  qui joue où à 20 s, AWPer, duels d'ouverture, utilitaires par lieu, phrases à retenir et pistes de contre ; chaque chiffre k/n avec fiabilité).
- /api/scouting/veto?team_a=&team_b= : forces par carte pour un veto.
- /api/scouting/learn?map=&side=CT|T : postes de la carte (lieu à 0:20, rounds, % de victoires, joueurs ; by_player = rounds par steamid).
  Avec &place=Lieu1,Lieu2 : chaque round joué à ce poste (survie, kills, mort, utilitaires, rotation, bombe, achats).
- /api/highlights?map=&player=&type= : moments forts (clutchs, multi-kills, aces…).
- /api/callouts?map= : lieux de la carte et noms donnés par l'équipe. /api/maps : cartes connues.
- /api/strats?map=&side= : stratbook de l'équipe ; /api/strats/{id} : une stratégie.
- /api/bookmarks : signets.
- /api/faceit/teams : équipes FACEIT suivies (team_id, nom, local_team_id = id de scouting par démos).
  /api/faceit/teams/{team_id}?scope=esea|all : fiche FACEIT (roster avec niveau et ELO, matchs ESEA récents avec adversaire,
  cartes et scores, map pool avec bilan, stats FACEIT et bans probables, démos importées). Pour l'analyse fine (setups CT,
  exécutions T, timings, utilitaires), utilise /api/scouting/teams/{local_team_id}/… si local_team_id existe."""

SYSTEM = """Tu es l'assistant d'analyse de Sightline, un logiciel d'analyse de démos Counter-Strike 2 utilisé par une équipe
pour progresser. Tu réponds en français, de façon précise et concrète, comme un analyste / coach CS2.

Règles :
- Appuie-toi uniquement sur les données de la bibliothèque, obtenues avec l'outil sightline_api. Ne devine pas de chiffres :
  si une donnée manque, dis-le et propose comment l'obtenir (importer des démos, filtrer autrement).
- Commence par trouver les identifiants utiles (matchs, équipes, steamid) puis interroge les routes précises. Garde les appels
  peu nombreux et ciblés.
- Cite tes sources avec des liens Markdown vers l'app, pour que l'utilisateur puisse vérifier :
  round : [R12](/matches/{match_id}/replay/12) ; match : [Match](/matches/{match_id}) ; joueur : [Nom](/players/{steamid}) ;
  équipe : [Équipe](/scouting/{team_id}) ; poste : [Poste](/learn?map=de_mirage&side=CT&place=BombsiteA).
- Réponds de façon structurée et courte : d'abord la réponse, puis les éléments qui l'appuient, puis 1 à 3 conseils actionnables.
- Les camps sont CT et T ; achats : pistol, eco, semi, force, full. Les lieux sont les noms du jeu (ex. BombsiteA, Palace).

""" + API_GUIDE

TOOLS = [{
    "name": "sightline_api",
    "description": "Interroge l'API de Sightline en lecture seule (GET). Voir la liste des routes dans les instructions. "
                   "Renvoie du JSON (compacté, éventuellement tronqué).",
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Chemin de la route, ex. /api/matches/3/stats"},
            "params": {"type": "object", "description": "Paramètres de requête, ex. {\"map\": \"de_mirage\", \"side\": \"T\"}",
                       "additionalProperties": {"type": ["string", "number", "boolean"]}},
        },
        "required": ["path"],
    },
}]


# ---------- configuration (clé, modèle) ----------



ENV_KEYS = {"anthropic": "SKYBOX_ANTHROPIC_API_KEY", "gemini": "SKYBOX_GEMINI_API_KEY"}


def config(data_dir: Path) -> dict:
    """Clé, modèle et fournisseur effectifs. La variable d'environnement l'emporte sur la clé saisie dans l'app ; sans
    modèle choisi, on prend celui du fournisseur dont on a une clé."""
    sec = read_secrets(data_dir)
    keys = {pv: (os.environ.get(env) or sec.get(f"{pv}_api_key")) for pv, env in ENV_KEYS.items()}
    model = os.environ.get("SKYBOX_AI_MODEL") or sec.get("ai_model")
    if not model or not keys[provider_of(model)]:
        pv = next((pv for pv in ("anthropic", "gemini") if keys[pv]), provider_of(model or DEFAULT_MODEL["anthropic"]))
        model = model if model and provider_of(model) == pv else DEFAULT_MODEL[pv]
    pv = provider_of(model)
    key = keys[pv]
    source = "env" if os.environ.get(ENV_KEYS[pv]) else ("app" if key else None)
    return {"key": key, "model": model, "provider": pv, "source": source, "providers": [k for k, v in keys.items() if v]}


def key_for(data_dir: Path, provider: str) -> str | None:
    """Clé d'un fournisseur (variable d'environnement, sinon clé saisie dans l'app)."""
    return os.environ.get(ENV_KEYS[provider]) or read_secrets(data_dir).get(f"{provider}_api_key")


def save_config(data_dir: Path, api_key: str | None = None, model: str | None = None, clear_key: bool = False) -> None:
    sec = read_secrets(data_dir)
    if clear_key:
        sec.pop("anthropic_api_key", None)
        sec.pop("gemini_api_key", None)
    elif api_key:
        sec[f"{provider_of_key(api_key)}_api_key"] = api_key
        if not model and provider_of(sec.get("ai_model") or "") != provider_of_key(api_key):
            sec["ai_model"] = DEFAULT_MODEL[provider_of_key(api_key)]
    if model:
        sec["ai_model"] = model
    write_secrets(data_dir, sec)


# ---------- outil : appel de l'API en interne ----------

def _compact(obj, depth: int = 0):
    """Allège une réponse : flottants arrondis, longues listes de nombres (trajectoires, images) résumées."""
    if isinstance(obj, float):
        return round(obj, 2)
    if isinstance(obj, dict):
        return {k: _compact(v, depth + 1) for k, v in obj.items() if k not in ("trajectory", "path", "frames", "slices", "hist")}
    if isinstance(obj, list):
        if len(obj) > 6 and all(isinstance(x, (int, float)) for x in obj):
            return f"[{len(obj)} nombres]"
        return [_compact(x, depth + 1) for x in obj]
    return obj


def allowed(path: str) -> bool:
    return any(r.match(path) for r in _ALLOWED_RE)


async def call_api(app, cookies: dict, path: str, params: dict | None) -> str:
    path = "/" + path.lstrip("/").split("?")[0]
    if not allowed(path):
        return json.dumps({"erreur": f"route non autorisée : {path}"}, ensure_ascii=False)
    params = {k: ("true" if v is True else "false" if v is False else str(v)) for k, v in (params or {}).items() if v is not None}
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sightline.internal", cookies=cookies, timeout=60) as c:
        r = await c.get(path, params=params)
    if r.status_code >= 400:
        return json.dumps({"erreur": r.status_code, "detail": r.text[:500]}, ensure_ascii=False)
    try:
        text = json.dumps(_compact(r.json()), ensure_ascii=False, separators=(",", ":"))
    except ValueError:
        text = r.text
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + f"… [tronqué : {len(text)} caractères ; affine avec des paramètres (map, match, limit…)]"
    return text


def step_label(path: str, params: dict | None) -> str:
    """Libellé lisible d'un appel d'outil, affiché pendant la réflexion."""
    p = params or {}
    labels = [(r"/api/matches/\d+/analysis", "Analyse du match"), (r"/api/matches/\d+/stats", "Stats du match"),
              (r"/api/matches/\d+$", "Détail du match"), (r"/api/matches", "Liste des matchs"), (r"/api/rounds/search", "Recherche de rounds"),
              (r"/api/players/extras", "Indicateurs des joueurs"), (r"/api/players/\d+/dashboard", "Tableau de bord du joueur"),
              (r"/api/players/\d+", "Fiche du joueur"), (r"/api/players", "Statistiques des joueurs"), (r"/api/teams", "Équipes"),
              (r"/api/scouting/teams/\d+/playbook", "Playbook de l'équipe"), (r"/api/scouting/teams/\d+/timings", "Timings de l'équipe"),
              (r"/api/scouting/teams/\d+/utility", "Lineups de l'équipe"), (r"/api/scouting/teams/\d+", "Rapport de scouting"),
              (r"/api/scouting/teams", "Équipes à scouter"), (r"/api/scouting/veto", "Veto"), (r"/api/scouting/learn", "Étude de poste"),
              (r"/api/highlights", "Moments forts"), (r"/api/callouts", "Callouts"), (r"/api/strats", "Stratbook")]
    name = next((l for pat, l in labels if re.search(pat, path)), path)
    extra = ", ".join(f"{k}={v}" for k, v in p.items())
    return f"{name}{f' ({extra})' if extra else ''}"


# ---------- conversation ----------

def _context_text(ctx: dict | None) -> str:
    if not ctx:
        return ""
    parts = []
    if ctx.get("me"):
        parts.append(f"Le joueur suivi par l'utilisateur (« moi ») a le steamid {ctx['me']}.")
    if ctx.get("match"):
        parts.append(f"L'utilisateur regarde le match {ctx['match']}.")
    if ctx.get("page"):
        parts.append(f"Page ouverte : {ctx['page']}.")
    return "\n\nContexte : " + " ".join(parts) if parts else ""


def _parse_params(raw) -> dict:
    """Paramètres d'un appel d'outil : objet (Claude) ou chaîne de requête « map=de_mirage&side=T » (Gemini)."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        from urllib.parse import parse_qsl
        return dict(parse_qsl(raw.strip().lstrip("?")))
    return {}


async def chat(app, cookies: dict, key: str, model: str, messages: list[dict], ctx: dict | None) -> AsyncIterator[dict]:
    """Boucle question → appels d'outils → réponse, en flux d'événements : {"type": "text"|"step"|"done"|"error", ...}."""
    gen = _chat_gemini if provider_of(model) == "gemini" else _chat_anthropic
    async for ev in gen(app, cookies, key, model, messages, ctx):
        yield ev


async def _chat_gemini(app, cookies: dict, key: str, model: str, messages: list[dict], ctx: dict | None) -> AsyncIterator[dict]:
    """Même boucle avec l'API REST de Gemini (appels de fonctions). Les parties renvoyées par le modèle sont recopiées
    telles quelles au tour suivant (signatures de raisonnement exigées par Gemini 3)."""
    tool = {"functionDeclarations": [{
        "name": "sightline_api",
        "description": TOOLS[0]["description"],
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Chemin de la route, ex. /api/matches/3/stats"},
            "params": {"type": "string", "description": "Paramètres de requête au format query string, ex. map=de_mirage&side=T (vide si aucun)"},
        }, "required": ["path"]},
    }]}
    contents = [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
                for m in messages if m.get("role") in ("user", "assistant") and m.get("content")]
    usage = {"input": 0, "output": 0}
    wrote = False
    headers = {"x-goog-api-key": key, "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=15)) as client:
            for _ in range(MAX_STEPS + 1):
                body = {"systemInstruction": {"parts": [{"text": SYSTEM + _context_text(ctx)}]}, "contents": contents,
                        "tools": [tool], "generationConfig": {"maxOutputTokens": MAX_TOKENS}}
                parts: list[dict] = []
                # modèle surchargé (503/500) : nouvel essai, puis repli sur Flash-Lite
                for attempt, m in enumerate([model, model, model, FALLBACK_GEMINI]):
                    r = await client.send(client.build_request("POST", f"{GEMINI_URL}/models/{m}:streamGenerateContent?alt=sse",
                                                               headers=headers, json=body), stream=True)
                    if r.status_code == 429:
                        # quota par minute du palier gratuit : Google indique le délai d'attente
                        detail = (await r.aread()).decode("utf-8", "replace")
                        await r.aclose()
                        wait = _retry_delay(detail)
                        if wait is None or wait > 45 or attempt >= 2:
                            yield {"type": "error", "message": _gemini_error(429, detail)}
                            return
                        yield {"type": "step", "label": f"Quota gratuit Gemini par minute atteint : reprise dans {wait} s…"}
                        await asyncio.sleep(wait + 1)
                        continue
                    if r.status_code not in (500, 502, 503, 504):
                        break
                    await r.aclose()
                    if attempt == 2:
                        yield {"type": "step", "label": "Serveur Gemini surchargé : nouvel essai avec Flash-Lite…"}
                    await asyncio.sleep(1.5 * (attempt + 1))
                try:
                    if r.status_code >= 400:
                        detail = (await r.aread()).decode("utf-8", "replace")
                        yield {"type": "error", "message": _gemini_error(r.status_code, detail)}
                        return
                    last_usage = None
                    async for line in r.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        chunk = json.loads(line[6:])
                        last_usage = chunk.get("usageMetadata") or last_usage
                        for cand in chunk.get("candidates", [])[:1]:
                            for part in (cand.get("content") or {}).get("parts", []):
                                parts.append(part)
                                if part.get("text") and not part.get("thought"):
                                    wrote = True
                                    yield {"type": "text", "text": part["text"]}
                    if last_usage:
                        usage["input"] += last_usage.get("promptTokenCount", 0)
                        usage["output"] += last_usage.get("candidatesTokenCount", 0) + last_usage.get("thoughtsTokenCount", 0)
                finally:
                    await r.aclose()
                calls = [p["functionCall"] for p in parts if "functionCall" in p]
                contents.append({"role": "model", "parts": parts or [{"text": ""}]})
                if not calls:
                    break
                responses = []
                for c in calls:
                    args = c.get("args") or {}
                    path, params = args.get("path", ""), _parse_params(args.get("params"))
                    yield {"type": "step", "label": step_label(path, params)}
                    fr = {"name": c.get("name", "sightline_api"), "response": {"result": await call_api(app, cookies, path, params)}}
                    if c.get("id"):
                        fr["id"] = c["id"]
                    responses.append({"functionResponse": fr})
                contents.append({"role": "user", "parts": responses})
                if wrote:  # séparateur entre deux tours seulement si du texte a déjà été écrit
                    yield {"type": "text", "text": "\n\n"}
                    wrote = False
        yield {"type": "done", "usage": usage, "model": model}
    except httpx.HTTPError:
        yield {"type": "error", "message": "Impossible de joindre l'API Gemini."}


def _retry_delay(detail: str) -> int | None:
    m = re.search(r'"retryDelay":\s*"(\d+)(?:\.\d+)?s"', detail)
    return int(m.group(1)) if m else None


def _gemini_error(status: int, detail: str) -> str:
    if status == 429:
        if "PerDay" in detail or "per day" in detail.lower():
            return "Quota gratuit Gemini du jour épuisé : réessayez demain, ou activez la facturation sur Google AI Studio."
        if "limit: 0" in detail:
            return ("Ce modèle n'est pas inclus dans le quota gratuit Google (Gemini Pro) : choisissez Gemini Flash dans les "
                    "réglages, ou activez la facturation sur Google AI Studio.")
        return "Quota Gemini par minute atteint : réessayez dans une minute (ou posez une question plus ciblée)."
    if status in (400, 401, 403) and ("API key" in detail or "PERMISSION" in detail or "UNAUTHENTICATED" in detail):
        return "Clé API Gemini refusée : vérifiez-la dans les réglages de l'assistant."
    if status == 404:
        return "Modèle Gemini introuvable : choisissez-en un autre dans les réglages."
    if status in (500, 502, 503, 504):
        return "Les serveurs Gemini sont surchargés pour le moment : réessayez dans une minute."
    return f"Erreur de l'API Gemini ({status})."


async def _chat_anthropic(app, cookies: dict, key: str, model: str, messages: list[dict], ctx: dict | None) -> AsyncIterator[dict]:
    import anthropic  # import différé : l'app démarre même sans le paquet

    client = anthropic.AsyncAnthropic(api_key=key)
    convo = [{"role": m["role"], "content": m["content"]} for m in messages if m.get("role") in ("user", "assistant") and m.get("content")]
    system = SYSTEM + _context_text(ctx)
    usage = {"input": 0, "output": 0}
    wrote = False
    try:
        for _ in range(MAX_STEPS + 1):
            async with client.messages.stream(model=model, max_tokens=MAX_TOKENS, system=system, tools=TOOLS, messages=convo) as stream:
                async for text in stream.text_stream:
                    wrote = True
                    yield {"type": "text", "text": text}
                final = await stream.get_final_message()
            usage["input"] += final.usage.input_tokens
            usage["output"] += final.usage.output_tokens
            convo.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in final.content]})
            calls = [b for b in final.content if b.type == "tool_use"]
            if final.stop_reason != "tool_use" or not calls:
                break
            results = []
            for b in calls:
                path, params = b.input.get("path", ""), _parse_params(b.input.get("params"))
                yield {"type": "step", "label": step_label(path, params)}
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": await call_api(app, cookies, path, params)})
            convo.append({"role": "user", "content": results})
            if wrote:
                yield {"type": "text", "text": "\n\n"}
                wrote = False
        yield {"type": "done", "usage": usage, "model": model}
    except anthropic.AuthenticationError:
        yield {"type": "error", "message": "Clé API refusée par Anthropic : vérifiez-la dans les réglages de l'assistant."}
    except anthropic.RateLimitError:
        yield {"type": "error", "message": "Limite de requêtes atteinte chez Anthropic : réessayez dans un instant."}
    except anthropic.APIStatusError as e:
        yield {"type": "error", "message": f"Erreur de l'API Anthropic ({e.status_code})."}
    except anthropic.APIConnectionError:
        yield {"type": "error", "message": "Impossible de joindre l'API Anthropic."}


async def check_key(key: str) -> bool:
    if provider_of_key(key) == "gemini":
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(f"{GEMINI_URL}/models", headers={"x-goog-api-key": key}, params={"pageSize": 1})
        if r.status_code in (400, 401, 403):
            return False
        r.raise_for_status()
        return True
    import anthropic

    try:
        await anthropic.AsyncAnthropic(api_key=key).models.list(limit=1)
        return True
    except anthropic.AuthenticationError:
        return False
