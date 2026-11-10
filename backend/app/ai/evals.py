# backend/app/ai/evals.py
"""Évaluation du rapport de scouting rédigé par l'IA (étape 5 du plan, reports/Rapport scouting CS2 par LLM.md).

Trois mesures :
1. Banc d'essai du contrôle (sans coût) : des erreurs connues sont injectées dans de vrais rapports (chiffre décalé,
   comptage d'un autre fait, pourcentage faux, mot absolu sur un fait fragile, fait inexistant, site ou joueur inversé)
   et l'on compte ce que `check_blocks` attrape, ainsi que ses fausses alertes sur le rapport intact.
2. Score d'un rapport (sans coût) : chiffres vérifiés, chiffres non justifiés, comptages mal appariés, couverture des
   points attendus par carte (pistols T/CT, premier gun round, site fragile, AWPer, joueurs), prudence sur les faits
   « à confirmer ».
3. Juge (Claude Haiku) : affirmations qualitatives non soutenues par les faits cités (« ils défendent mal A » alors que
   les faits disent B), que le contrôle des nombres ne peut pas voir.
Une campagne génère des rapports pour plusieurs équipes et plusieurs modèles, et compare score, juge, coût et durée."""
from __future__ import annotations

import asyncio
import copy
import json
import random
import re
import time

from app.ai import report

HEDGES = re.compile(r"à confirmer|seulement|peu de|petit échantillon|trop peu|tendance|un seul|une seule|anecdot",
                    re.IGNORECASE)
JUDGE_MODEL = "claude-haiku-5-5"


# ----------------------------------------------------------------------------------------- 1. banc d'essai du contrôle
def _pair_sentences(text: str):
    for s in report._sentences(text):
        m = report.PAIR.search(s)
        if m:
            yield s, m


def mutations(content: dict, facts: dict[str, dict], seed: int = 0, per_kind: int = 6) -> list[dict]:
    """Copies du rapport avec une erreur injectée chacune : {kind, expected ('code'|'judge'), section, block, content}."""
    rnd = random.Random(seed)
    out: list[dict] = []
    places = [(si, bi) for si, s in enumerate(content["sections"]) for bi, _ in enumerate(s["blocks"])]
    rnd.shuffle(places)

    def mutate(kind: str, expected: str, fn) -> None:
        n = 0
        for si, bi in places:
            if n >= per_kind:
                return
            c = copy.deepcopy(content)
            b = c["sections"][si]["blocks"][bi]
            new = fn(b)
            if new is None or new == b["text"]:
                continue
            b["text"] = new
            out.append({"kind": kind, "expected": expected, "section": si, "block": bi, "content": c})
            n += 1

    def bump_count(b):                       # « 7 sur 9 » → « 8 sur 9 »
        for s, m in _pair_sentences(b["text"]):
            x, y = int(m.group(1)), int(m.group(2))
            nx = x + 1 if x < y else x - 1
            return b["text"].replace(s, s.replace(m.group(0), m.group(0).replace(m.group(1), str(nx), 1), 1), 1)

    def other_fact_count(b):                 # « 7 sur 9 » → k/n d'un autre fait (souvent plausible)
        cited = [facts[i] for i in b["fact_ids"] if i in facts and facts[i].get("k") is not None]
        pool = [f for f in facts.values() if f.get("k") is not None and f not in cited and f.get("n")]
        if not pool:
            return None
        for s, m in _pair_sentences(b["text"]):
            f = rnd.choice(pool)
            if (f["k"], f["n"]) == (int(m.group(1)), int(m.group(2))):
                continue
            return b["text"].replace(s, s.replace(m.group(0), f"{f['k']} sur {f['n']}", 1), 1)

    def wrong_pct(b):                        # « (78 %) » → « (85 %) »
        m = re.search(r"(\d+)\s?%", b["text"])
        if not m:
            return None
        v = int(m.group(1))
        nv = v + 7 if v <= 90 else v - 7
        return b["text"][:m.start(1)] + str(nv) + b["text"][m.end(1):]

    def absolute_word(b):                    # mot absolu sur un fait à confirmer
        if not any(facts.get(i, {}).get("level") == "anecdotal" for i in b["fact_ids"]):
            return None
        s = report._sentences(b["text"])[0]
        return b["text"].replace(s, s.rstrip(".") + ", et ils le font toujours.", 1)

    def unknown_fact(b):                     # fait cité qui n'existe pas
        b["fact_ids"] = b["fact_ids"] + ["inexistant.T.pistol"]
        return b["text"] + " "

    def invented_number(b):                  # nombre sans aucune source
        s = report._sentences(b["text"])[0]
        return b["text"].replace(s, s.rstrip(".") + f" (environ {rnd.randint(41, 97)} rounds au total).", 1)

    def swap_site(b):                        # A ↔ B : erreur de sens, invisible pour le contrôle des nombres
        t = b["text"]
        if not re.search(r"\bsite [AB]\b|\b[AB] \(|vers [AB]\b|sur [AB]\b", t):
            return None
        return re.sub(r"\b(site|vers|sur) ([AB])\b", lambda m: f"{m.group(1)} {'B' if m.group(2) == 'A' else 'A'}", t)

    def swap_player(b):                      # deux joueurs inversés
        names = sorted({f["label"].split(" : ")[1].split(" ")[0].rstrip(",") for f in facts.values()
                        if f.get("topic") == "player" and " : " in f["label"]})
        present = [n for n in names if n and n in b["text"]]
        if len(present) < 2:
            return None
        a, c2 = present[0], present[1]
        return b["text"].replace(a, "\0").replace(c2, a).replace("\0", c2)

    mutate("chiffre décalé", "code", bump_count)
    mutate("comptage d'un autre fait", "code", other_fact_count)
    mutate("pourcentage faux", "code", wrong_pct)
    mutate("mot absolu sur fait fragile", "code", absolute_word)
    mutate("fait inexistant", "code", unknown_fact)
    mutate("nombre inventé", "code", invented_number)
    mutate("site inversé", "judge", swap_site)
    mutate("joueurs inversés", "judge", swap_player)
    return out


def _caught(content: dict, facts: dict[str, dict], si: int, bi: int) -> bool:
    blocks = content["sections"][si]["blocks"]
    return any(p["block"] == bi for p in report.check_blocks(blocks, facts))


def checker_benchmark(reports: list[tuple[dict, dict[str, dict]]], seed: int = 0) -> dict:
    """reports : [(content, faits)]. Taux de détection par type d'erreur et fausses alertes sur les rapports intacts."""
    kinds: dict[str, dict] = {}
    false_alarms = blocks_total = 0
    for content, facts in reports:
        for s in content["sections"]:
            probs = report.check_blocks(s["blocks"], facts)
            false_alarms += len({p["block"] for p in probs})
            blocks_total += len(s["blocks"])
        for m in mutations(content, facts, seed=seed):
            k = kinds.setdefault(m["kind"], {"expected": m["expected"], "n": 0, "caught": 0})
            k["n"] += 1
            k["caught"] += _caught(m["content"], facts, m["section"], m["block"])
    for k in kinds.values():
        k["rate"] = round(100 * k["caught"] / k["n"]) if k["n"] else None
    code = [k for k in kinds.values() if k["expected"] == "code"]
    return {"kinds": kinds, "blocks": blocks_total, "false_alarm_blocks": false_alarms,
            "code_detection": round(100 * sum(k["caught"] for k in code) / max(1, sum(k["n"] for k in code)))}


# ---------------------------------------------------------------------------------------------- 2. score d'un rapport
EXPECTED = (("pistol T", ".T.pistol"), ("pistol CT", ".CT.pistol"), ("premier gun round", "first_gun"),
            ("défense des sites", ".held"), ("joueurs", ".player."))


def score_report(content: dict, facts: dict[str, dict]) -> dict:
    sections = content.get("sections", [])
    numbers = issues = pair_issues = hedge_missing = anecdotal_blocks = 0
    coverage: dict[str, dict] = {}
    for s in sections:
        probs = report.check_blocks(s["blocks"], facts)
        issues += len(probs)
        pair_issues += sum(1 for p in probs for i in p["issues"] if i.startswith("comptage"))
        for b in s["blocks"]:
            numbers += len([x for x in report.NUM.findall(b["text"]) if x not in report.FREE_NUMBERS])
            if any(facts.get(i, {}).get("level") == "anecdotal" for i in b["fact_ids"]):
                anecdotal_blocks += 1
                hedge_missing += not HEDGES.search(b["text"])
        if s.get("map"):
            ids = " ".join(i for b in s["blocks"] for i in b["fact_ids"])
            coverage[s["map"]] = {name: (pat in ids) for name, pat in EXPECTED}
    cov = [v for m in coverage.values() for v in m.values()]
    return {"numbers": numbers, "issues": issues, "pair_issues": pair_issues,
            "coverage_pct": round(100 * sum(cov) / len(cov)) if cov else None, "coverage": coverage,
            "anecdotal_blocks": anecdotal_blocks, "hedge_missing": hedge_missing,
            "words": sum(len(b["text"].split()) for s in sections for b in s["blocks"])}


# ----------------------------------------------------------------------------------------------------- 3. juge
JUDGE_SYSTEM = """Tu vérifies un rapport de scouting Counter-Strike 2. Pour chaque bloc, on te donne son texte et les
faits qu'il cite (calculés par un logiciel, donc justes). Signale chaque affirmation du texte qui est contredite par les
faits cités ou qui n'est soutenue par aucun d'eux : mauvais site (A/B), mauvais joueur, mauvais camp (T/CT), tendance
inventée, conclusion opposée aux chiffres. Les conseils de jeu (« jouez groupés ») ne sont pas des affirmations à
vérifier, ni une nuance de formulation. Sois précis : n'invente pas de problème et ne liste PAS ce qui est correct.
Pour chaque élément, "verdict" vaut "contredit" (les faits disent autre chose), "non_soutenu" (aucun fait ne le dit) ou
"correct" (si tu t'aperçois en l'écrivant que c'est juste). Réponds en JSON
{"problems": [{"block": n, "claim": "...", "verdict": "...", "reason": "..."}]}."""
JUDGE_SCHEMA = {"type": "object", "required": ["problems"], "additionalProperties": False, "properties": {"problems": {
    "type": "array", "items": {"type": "object", "required": ["block", "claim", "verdict", "reason"], "additionalProperties": False,
                               "properties": {"block": {"type": "integer"}, "claim": {"type": "string"},
                                              "verdict": {"type": "string", "enum": ["contredit", "non_soutenu", "correct"]},
                                              "reason": {"type": "string"}}}}}}


def judge_llm(key: str):
    async def call(system: str, user: str) -> tuple[str, int, int]:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=key, max_retries=3)
        msg = await client.messages.create(model=JUDGE_MODEL, max_tokens=8000, system=system,
                                           output_config={"format": {"type": "json_schema", "schema": JUDGE_SCHEMA},
                                                          "effort": "low"},
                                           messages=[{"role": "user", "content": user}])
        return "".join(b.text for b in msg.content if b.type == "text"), msg.usage.input_tokens, msg.usage.output_tokens
    return call


JUDGE_PARALLEL = 4  # limite de débit de l'API : pas plus de 4 appels du juge à la fois


async def judge(content: dict, facts: dict[str, dict], llm, sem: asyncio.Semaphore | None = None) -> dict:
    """Problèmes qualitatifs par section (un appel par section, en parallèle mais limité)."""
    usage = [0, 0]
    sem = sem or asyncio.Semaphore(JUDGE_PARALLEL)

    async def one(s):
        async with sem:
            return await _one(s)

    async def _one(s):
        parts = []
        for i, b in enumerate(s["blocks"]):
            cited = [facts[x] for x in b["fact_ids"] if x in facts]
            parts.append(f"## Bloc {i}\nTexte : {b['text']}\nFaits cités :\n" +
                         "\n".join(json.dumps({k: v for k, v in f.items() if k != "map"}, ensure_ascii=False)
                                   for f in cited))
        text, ti, to = await llm(JUDGE_SYSTEM, "\n\n".join(parts))
        usage[0] += ti
        usage[1] += to
        try:
            return [{**p, "section": s["key"]} for p in json.loads(text).get("problems", [])
                    if p.get("verdict", "contredit") != "correct"]
        except (ValueError, AttributeError):
            return []

    probs = [p for ps in await asyncio.gather(*(one(s) for s in content["sections"])) for p in ps]
    return {"problems": probs, "count": len(probs), "tokens_in": usage[0], "tokens_out": usage[1],
            "cost_usd": report.cost_of(JUDGE_MODEL, usage[0], usage[1])}


async def judge_benchmark(content: dict, facts: dict[str, dict], llm, n: int = 6, seed: int = 1) -> dict:
    """Calibrage du juge : erreurs de sens injectées (site, joueurs) attrapées, et alertes sur le rapport intact."""
    muts = [m for m in mutations(content, facts, seed=seed, per_kind=n) if m["expected"] == "judge"]
    sem = asyncio.Semaphore(4)

    async def one(m):
        async with sem:
            res = await judge({"sections": [m["content"]["sections"][m["section"]]]}, facts, llm)
            return m["kind"], any(p["block"] == m["block"] for p in res["problems"]), res["cost_usd"] or 0

    base, *rows = await asyncio.gather(judge(content, facts, llm), *(one(m) for m in muts))
    by_kind: dict[str, list[int]] = {}
    for kind, ok, _ in rows:
        by_kind.setdefault(kind, [0, 0])[0] += ok
        by_kind[kind][1] += 1
    caught = sum(ok for _, ok, _ in rows)
    return {"intact_alerts": base["count"], "intact_examples": base["problems"][:5], "injected": len(muts),
            "caught": caught, "rate": round(100 * caught / len(muts)) if muts else None,
            "by_kind": {k: f"{c}/{n}" for k, (c, n) in by_kind.items()},
            "cost_usd": round((base["cost_usd"] or 0) + sum(c for _, _, c in rows), 4)}


# ------------------------------------------------------------------------------------------------------ campagne
async def campaign(sheets: list[dict], models: list[str], key: str, with_judge: bool = True) -> dict:
    """Pour chaque équipe et chaque modèle : rapport, score, juge, coût, durée."""
    jl = judge_llm(key)
    runs = []
    for sheet in sheets:
        facts = {f["id"]: f for f in sheet["facts"]}
        for model in models:
            t0 = time.monotonic()
            row = {"team": sheet["team"]["name"], "model": model, "facts": len(facts)}
            try:
                res = await report.generate(sheet, report.llm_for(key, model))
                content = {"sections": res["sections"]}
                row.update({"latency_s": round(time.monotonic() - t0, 1), "cost_usd": report.cost_of(model, res["tokens_in"], res["tokens_out"]),
                            "first_pass_issues": res["checks"]["first_pass_issues"],
                            "removed_sentences": res["checks"]["removed_sentences"], **score_report(content, facts)})
                if with_judge:
                    j = await judge(content, facts, jl)
                    row.update({"judge_problems": j["count"], "judge_examples": j["problems"][:5], "judge_cost_usd": j["cost_usd"]})
                row["content"] = content
            except Exception as e:  # noqa: BLE001 — une ligne en échec n'arrête pas la campagne
                row["error"] = str(e)[:300]
            runs.append(row)
    return {"runs": runs, "models": models, "teams": [s["team"]["name"] for s in sheets]}
