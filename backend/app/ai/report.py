# backend/app/ai/report.py
"""Rapport de scouting rédigé par l'IA, vérifié en code (plan : reports/Rapport scouting CS2 par LLM.md).

Chaîne fixe, pas d'agent libre : fiche de faits (app.stats.facts) → une section par appel, en parallèle (synthèse, puis
une par carte) → sortie JSON où chaque bloc cite ses `fact_ids` → contrôle en code :
  - chaque nombre du texte doit venir d'un fait cité (k, n, %, fourchette, valeur, ou chiffres du libellé/des exemples) ;
  - pas de mots absolus (« toujours », « jamais »…) appuyés sur un fait « à confirmer » ;
  - identifiants de faits existants.
En cas d'écart, une seconde passe demande la correction ; les phrases encore fautives sont retirées (et comptées)."""
from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Awaitable, Callable

import httpx

from app.ai.assistant import GEMINI_URL, provider_of

# prix publics en $ par million de jetons (entrée, sortie), relevés le 13/10/2026 ; None : inconnu
PRICES = {"claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5-5": (2.0, 10.0), "claude-haiku-5-5": (0.10, 0.50),
          "gemini-flash-latest": (0.75, 3.75)}
MAX_TOKENS = 16000
PARALLEL = 3
FREE_NUMBERS = {str(i) for i in range(6)}  # « 3 actions », « 2 joueurs » : petits nombres de langage courant
STRONG = re.compile(r"\b(toujours|jamais|systématiquement|à chaque fois|tout le temps|sans exception)\b", re.IGNORECASE)
NUM = re.compile(r"(?<![\w.,])\d+(?:[.,]\d+)?")
DIGITS = re.compile(r"\d+(?:[.,]\d+)?")
PAIR = re.compile(r"(?<![\w.,])(\d+)\s+(?:(?:fois|rounds?|matchs?|victoires?|reprises?|retakes?|pistols?)\s+)?sur\s+(\d+)\b")  # « 7 sur 9 », « 7 fois sur 9 », « 18 rounds sur 24 »
PCT = re.compile(r"(?<![\w.,])(\d+(?:[.,]\d+)?)\s?%")
PAIR_PCT = re.compile(r"(?<![\w.,])(\d+)\s+(?:(?:fois|rounds?|matchs?|victoires?|reprises?|retakes?|pistols?)\s+)?sur\s+(\d+)[^.%\d]{0,40}?\((\d+(?:[.,]\d+)?)\s?%")
SENTENCE = re.compile(r"(?<=[.!?])\s+")

# schéma imposé à la réponse (sorties structurées chez Anthropic, responseSchema chez Gemini) : JSON toujours valide
SCHEMA = {"type": "object", "required": ["blocks"], "properties": {"blocks": {"type": "array", "items": {
    "type": "object", "required": ["title", "text", "fact_ids"], "properties": {
        "title": {"type": "string"}, "text": {"type": "string"}, "fact_ids": {"type": "array", "items": {"type": "string"}}}}}}}


def _strict(schema: dict) -> dict:
    """Sorties structurées d'Anthropic : chaque objet doit interdire les propriétés non déclarées."""
    if schema.get("type") == "object":
        schema = {**schema, "additionalProperties": False,
                  "properties": {k: _strict(v) for k, v in schema.get("properties", {}).items()}}
    elif schema.get("type") == "array":
        schema = {**schema, "items": _strict(schema["items"])}
    return schema


ANTHROPIC_FORMAT = {"type": "json_schema", "schema": _strict(SCHEMA)}

LLM = Callable[[str, str], Awaitable[tuple[str, int, int]]]  # (system, user) → (texte, jetons entrée, jetons sortie)

SYSTEM = """Tu es analyste Counter-Strike 2 et tu écris un rapport de scouting (anti-strat) pour une équipe amateur
qui va affronter l'équipe décrite. Tu écris en français simple, pour un joueur débutant : phrases courtes, termes
techniques expliqués en quelques mots la première fois (pistol, force, default, setup, trade, AWP).

Règles impératives :
1. Tu n'utilises QUE les faits fournis (une ligne JSON par fait). Chaque bloc cite dans "fact_ids" les identifiants
   des faits dont il tire ses chiffres et affirmations. Aucun chiffre qui ne soit dans un fait cité.
2. Les chiffres s'écrivent en comptage d'abord : « 7 fois sur 9 », éventuellement suivi du pourcentage du fait.
   Un comptage « X sur Y » reprend exactement le k et le n d'UN même fait (jamais le k d'un fait avec le n d'un autre).
3. Fiabilité : "anecdotal" → dis « à confirmer » ou « sur seulement N rounds » ; "indicative" → « tendance » ;
   "solid" → affirmation normale. Jamais « toujours », « jamais », « systématiquement » sur un fait "anecdotal".
4. Les conseils suivent la forme : déclencheur → contre → risque (ce qu'il faut garder en tête si l'adversaire change).
5. S'il n'y a pas assez de données pour une partie, écris-le simplement plutôt que d'inventer.
6. Réponds UNIQUEMENT avec un objet JSON : {"blocks": [{"title": "...", "text": "...", "fact_ids": ["..."]}]}.
   "text" peut contenir des listes Markdown simples (lignes commençant par « - »)."""

SUMMARY_PLAN = """Section : synthèse de tout le rapport (lue en 2 minutes avant le match). Blocs, dans cet ordre :
- "À retenir" : 4 à 6 lignes, les informations les plus utiles toutes cartes confondues ;
- "Veto" : cartes fortes et faibles d'après les matchs analysés, carte probablement bannie si les faits le suggèrent ;
- "3 actions prioritaires" : trois conseils concrets, chacun avec sa preuve (comptage) et sa fiabilité."""

MAP_PLAN = """Section : la carte {name}. Blocs, dans cet ordre :
- "Pistols et économie" : pistol T et pistol CT (ce qu'ils jouent, résultat), round suivant le pistol, premier round
  avec armes complètes ;
- "Leur attaque (votre défense)" : façon d'attaquer, sites, timing, grenades habituelles (au plus 3 tendances) ;
- "Leur défense (votre attaque)" : placement habituel, site le plus fragile, grenades (au plus 3 tendances) ;
- "Qui joue où" : une ligne par joueur (poste en CT et en T, AWP, duels d'ouverture) ;
- "Comment les battre" : 3 à 5 conseils « déclencheur → contre → risque »."""


# ------------------------------------------------------------------------------------------------- appel du modèle
def llm_for(key: str, model: str) -> LLM:
    async def call(system: str, user: str) -> tuple[str, int, int]:
        if provider_of(model) == "gemini":
            body = {"systemInstruction": {"parts": [{"text": system}]}, "contents": [{"role": "user", "parts": [{"text": user}]}],
                    "generationConfig": {"maxOutputTokens": MAX_TOKENS, "responseMimeType": "application/json",
                                         "responseSchema": SCHEMA}}
            async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=15)) as c:
                for attempt in range(3):
                    r = await c.post(f"{GEMINI_URL}/models/{model}:generateContent", headers={"x-goog-api-key": key}, json=body)
                    if r.status_code not in (429, 500, 502, 503, 504) or attempt == 2:
                        break
                    await asyncio.sleep(5 * (attempt + 1))
            r.raise_for_status()
            j = r.json()
            text = "".join(p.get("text", "") for p in j["candidates"][0]["content"]["parts"] if not p.get("thought"))
            u = j.get("usageMetadata") or {}
            return text, int(u.get("promptTokenCount", 0)), int(u.get("candidatesTokenCount", 0))
        import anthropic

        client = anthropic.AsyncAnthropic(api_key=key, max_retries=3)
        # la réflexion (activée par défaut sur les modèles récents) compte dans max_tokens : marge large
        msg = await client.messages.create(model=model, max_tokens=MAX_TOKENS, system=system,
                                           output_config={"format": ANTHROPIC_FORMAT, "effort": "medium"},
                                           messages=[{"role": "user", "content": user}])
        if msg.stop_reason == "refusal":
            raise ValueError("demande refusée par le modèle")
        text = "".join(b.text for b in msg.content if b.type == "text")
        return text, msg.usage.input_tokens, msg.usage.output_tokens
    return call


def cost_of(model: str, tokens_in: int, tokens_out: int) -> float | None:
    p = PRICES.get(model)
    return round((tokens_in * p[0] + tokens_out * p[1]) / 1e6, 4) if p else None


# ------------------------------------------------------------------------------------------------------ contrôle
def _num(s: str) -> float:
    return float(s.replace(",", "."))


def allowed_numbers(facts: list[dict]) -> tuple[set[float], set[float]]:
    """(valeurs exactes autorisées, pourcentages autorisés à ±1)."""
    exact, pcts = set(), set()
    for f in facts:
        for k in ("k", "n", "lo", "hi"):
            if f.get(k) is not None:
                exact.add(float(f[k]))
        if f.get("pct") is not None:
            pcts.add(float(f["pct"]))
        if f.get("value") is not None:
            exact.add(float(f["value"]))
        for txt in [f.get("label", ""), *f.get("examples", [])]:
            exact |= {_num(x) for x in DIGITS.findall(txt)}  # y compris « R13 », « A3 · B2 »
    return exact, pcts


def sentence_issues(sentence: str, cited: list[dict]) -> list[str]:
    exact, pcts = allowed_numbers(cited)
    bounds = {float(f[k]) for f in cited for k in ("lo", "hi") if f.get(k) is not None}
    issues = []
    pct_spans = {m.start(1) for m in PCT.finditer(sentence)}
    for m in NUM.finditer(sentence):
        raw = m.group(0)
        v = _num(raw)
        if m.start() in pct_spans:  # un pourcentage doit être celui d'un fait cité (ou une borne de sa fourchette)
            if any(abs(v - p) <= 1 for p in pcts) or v in bounds:
                continue
            issues.append(f"pourcentage « {raw} % » absent des faits cités")
            continue
        if raw in FREE_NUMBERS:
            continue
        if v in exact or any(abs(v - p) <= 1 for p in pcts):
            continue
        issues.append(f"nombre « {raw} » absent des faits cités")
    # « X sur Y (Z %) » : Z doit être le calcul de X/Y
    for x, y, z in PAIR_PCT.findall(sentence):
        if _num(y) and abs(_num(z) - 100 * _num(x) / _num(y)) > 1:
            issues.append(f"« {x} sur {y} » ne fait pas {z} %")
    # un comptage « X sur Y » doit correspondre au k/n d'un même fait (sinon « 3 sur 3 » passerait avec k=2, n=3)
    pairs = {(float(f["k"]), float(f["n"])) for f in cited if f.get("k") is not None and f.get("n") is not None}
    for x, y in PAIR.findall(sentence):
        if (_num(x), _num(y)) not in pairs:
            issues.append(f"comptage « {x} sur {y} » ne correspond à aucun fait cité")
    if STRONG.search(sentence) and any(f.get("level") == "anecdotal" for f in cited):
        issues.append(f"mot absolu « {STRONG.search(sentence).group(0)} » sur un fait à confirmer")
    return issues


def check_blocks(blocks: list[dict], facts: dict[str, dict]) -> list[dict]:
    """Problèmes par bloc : [{block, sentence, issues}]."""
    out = []
    for i, b in enumerate(blocks):
        ids = [x for x in b.get("fact_ids", []) if isinstance(x, str)]
        unknown = [x for x in ids if x not in facts]
        cited = [facts[x] for x in ids if x in facts]
        if unknown:
            out.append({"block": i, "sentence": None, "issues": [f"faits inconnus : {', '.join(unknown[:5])}"]})
        for s in _sentences(str(b.get("text", ""))):
            iss = sentence_issues(s, cited)
            if iss:
                out.append({"block": i, "sentence": s, "issues": iss})
    return out


def _sentences(text: str) -> list[str]:
    parts = []
    for line in text.split("\n"):
        parts += [s for s in SENTENCE.split(line) if s.strip()]
    return parts


def drop_bad_sentences(blocks: list[dict], problems: list[dict]) -> int:
    bad = {(p["block"], p["sentence"]) for p in problems if p["sentence"]}
    removed = 0
    for i, b in enumerate(blocks):
        lines = []
        for line in str(b.get("text", "")).split("\n"):
            kept = [s for s in SENTENCE.split(line) if s.strip() and (i, s) not in bad]
            removed += len([s for s in SENTENCE.split(line) if s.strip()]) - len(kept)
            if kept or not line.strip():
                lines.append(" ".join(kept))
        b["text"] = "\n".join(lines).strip()
        b["fact_ids"] = [x for x in b.get("fact_ids", []) if isinstance(x, str)]
    return removed


def parse_blocks(text: str) -> list[dict]:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("pas de JSON")
    data = json.loads(text[start:end + 1])
    blocks = data.get("blocks") if isinstance(data, dict) else None
    if not isinstance(blocks, list):
        raise ValueError("pas de blocs")
    return [{"title": str(b.get("title", "")), "text": str(b.get("text", "")),
             "fact_ids": [x for x in b.get("fact_ids", []) if isinstance(x, str)]} for b in blocks if isinstance(b, dict)]


# ----------------------------------------------------------------------------------------------------- génération
def _facts_text(facts: list[dict]) -> str:
    return "\n".join(json.dumps({k: v for k, v in f.items() if v not in (None, [], "")}, ensure_ascii=False) for f in facts)


async def _section(llm: LLM, plan: str, facts: list[dict], header: str, by_id: dict[str, dict], usage: list[int],
                   system: str = SYSTEM) -> dict:
    user = f"{header}\n\n{plan}\n\nFaits :\n{_facts_text(facts)}"
    text, ti, to = await llm(system, user)
    usage[0] += ti
    usage[1] += to
    try:
        blocks = parse_blocks(text)
    except (ValueError, json.JSONDecodeError):
        try:
            text, ti, to = await llm(system, user + "\n\nRéponds uniquement avec l'objet JSON demandé.")
            usage[0] += ti
            usage[1] += to
            blocks = parse_blocks(text)
        except (ValueError, json.JSONDecodeError):  # une partie illisible n'annule pas tout le rapport
            return {"blocks": [{"title": "", "text": "Cette partie n'a pas pu être rédigée : réponse illisible de l'IA. "
                                "Régénérez le rapport.", "fact_ids": []}],
                    "checks": {"first_pass_issues": 0, "removed_sentences": 0, "remaining": [], "numbers_checked": 0,
                               "failed": True}}
    problems = check_blocks(blocks, by_id)
    first = len(problems)
    if problems:  # seconde passe : on montre précisément ce qui ne va pas
        fix = "\n".join(f"- bloc {p['block'] + 1}" + (f", phrase « {p['sentence']} »" if p["sentence"] else "") + " : "
                        + "; ".join(p["issues"]) for p in problems[:30])
        retry = (f"{user}\n\nTa réponse précédente :\n{json.dumps({'blocks': blocks}, ensure_ascii=False)}\n\n"
                 f"Le contrôle automatique a trouvé ces problèmes :\n{fix}\n\nCorrige-les (retire ou reformule ; cite les "
                 "bons fact_ids) et renvoie l'objet JSON complet.")
        try:
            text, ti, to = await llm(system, retry)
            usage[0] += ti
            usage[1] += to
            blocks = parse_blocks(text)
            problems = check_blocks(blocks, by_id)
        except (ValueError, json.JSONDecodeError):
            pass
    removed = drop_bad_sentences(blocks, problems) if problems else 0
    blocks = [b for b in blocks if b["text"]]
    numbers = sum(len([x for x in NUM.findall(b["text"]) if x not in FREE_NUMBERS]) for b in blocks)
    return {"blocks": blocks, "checks": {"first_pass_issues": first, "removed_sentences": removed,
                                         "remaining": [p for p in problems if not p["sentence"]], "numbers_checked": numbers}}


async def generate(sheet: dict, llm: LLM) -> dict:
    facts = sheet["facts"]
    by_id = {f["id"]: f for f in facts}
    team = sheet["team"]["name"]
    header = (f"Équipe adverse : {team}. Démos analysées : {sheet['matches']} match(s). "
              "Les faits ci-dessous sont calculés par le logiciel à partir de ces démos.")
    general = [f for f in facts if f["map"] is None or f["topic"] == "pool"]
    plans: list[tuple[str, str, str | None, str, list[dict]]] = [("summary", "Synthèse", None, SUMMARY_PLAN, facts)]
    for mp in sheet["maps"]:
        mf = [f for f in facts if f["map"] == mp]
        name = next((f["label"].split(" : ")[0] for f in mf), mp)
        plans.append((f"map:{mp}", name, mp, MAP_PLAN.format(name=name), general + mf))
    usage = [0, 0]
    sem = asyncio.Semaphore(PARALLEL)

    async def run(key, title, mp, plan, fs):
        async with sem:
            res = await _section(llm, plan, fs, header, by_id, usage)
            return {"key": key, "title": title, "map": mp, **res}

    t0 = time.monotonic()
    sections = await asyncio.gather(*(run(*p) for p in plans))
    checks = {"sections": {s["key"]: s.pop("checks") for s in sections}}
    checks["numbers_checked"] = sum(c["numbers_checked"] for c in checks["sections"].values())
    checks["first_pass_issues"] = sum(c["first_pass_issues"] for c in checks["sections"].values())
    checks["removed_sentences"] = sum(c["removed_sentences"] for c in checks["sections"].values())
    used = {x for s in sections for b in s["blocks"] for x in b["fact_ids"]}
    return {"sections": sections, "facts": {k: by_id[k] for k in used if k in by_id}, "checks": checks,
            "tokens_in": usage[0], "tokens_out": usage[1], "latency_s": round(time.monotonic() - t0, 1)}
