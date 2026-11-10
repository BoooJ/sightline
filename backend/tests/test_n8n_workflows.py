# backend/tests/test_n8n_workflows.py
"""Les workflows n8n du dépôt : générés à jour, nœuds et versions connus de n8n 2.44, aucun secret, credentials déclarés
dans le modèle (vide) que l'installation importe."""
import json
import re
import subprocess
import sys

import pytest

from app.core.config import ROOT

N8N = ROOT / "deploy" / "n8n"
FILES = ("w0-erreurs.json", "w1-pracc.json", "w2-discord.json", "w4-formulaire.json", "w5-prep.json", "w6-faceit.json")
# version de chaque nœud vérifiée dans le conteneur n8n 2.44.6 (dist/types/nodes.json)
KNOWN = {"n8n-nodes-base.errorTrigger": 1, "n8n-nodes-base.code": 2, "n8n-nodes-base.discord": 2,
         "n8n-nodes-base.scheduleTrigger": 1.2, "n8n-nodes-base.httpRequest": 4.2, "n8n-nodes-base.switch": 3.2,
         "n8n-nodes-base.webhook": 2.2, "n8n-nodes-base.respondToWebhook": 1.5, "n8n-nodes-base.formTrigger": 2.6, "@n8n/n8n-nodes-langchain.chainLlm": 1.9,
         "@n8n/n8n-nodes-langchain.lmChatAnthropic": 1.6}
SECRET = re.compile(r"sl_[A-Za-z0-9_-]{20,}|discord(?:app)?\.com/api/webhooks/\d|sk-ant-|Bearer [A-Za-z0-9]")


@pytest.fixture(scope="module")
def creds():
    return {c["id"]: c for c in json.loads((N8N / "credentials.template.json").read_text(encoding="utf-8"))}


def test_generated_files_up_to_date():
    r = subprocess.run([sys.executable, str(N8N / "build_workflows.py"), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.mark.parametrize("name", FILES)
def test_workflow_structure(name, creds):
    raw = (N8N / "workflows" / name).read_text(encoding="utf-8")
    assert not SECRET.search(raw)
    wf = json.loads(raw)
    names = [n["name"] for n in wf["nodes"]]
    assert len(names) == len(set(names)) and wf["active"] is False
    for n in wf["nodes"]:
        assert KNOWN.get(n["type"]) == n["typeVersion"], n["name"]
        for ctype, ref in n.get("credentials", {}).items():
            c = creds[ref["id"]]
            assert (c["type"], c["name"]) == (ctype, ref["name"])
    for src, outs in wf["connections"].items():
        assert src in names
        for branches in outs.values():
            assert all(t["node"] in names for branch in branches for t in branch)
    # pas d'agent à outils : l'agent de n8n 2 n'exécute plus les anciens outils HTTP et la boucle cassait (23/10)
    assert not any(n["type"].endswith(("toolHttpRequest", ".agent")) for n in wf["nodes"])
    if name != "w0-erreurs.json":
        assert wf["settings"]["errorWorkflow"] == "sightlineW0err01"


def test_w1_answers_the_extension_on_every_path():
    # W1 est appelé par l'extension Chrome (secret en en-tête) ; chaque chemin doit lui répondre, sinon elle attend
    wf = json.loads((N8N / "workflows" / "w1-pracc.json").read_text(encoding="utf-8"))
    nodes = {n["name"]: n for n in wf["nodes"]}
    hook = nodes["Extension PRACC"]
    assert hook["type"] == "n8n-nodes-base.webhook"
    assert (hook["parameters"]["authentication"], hook["parameters"]["responseMode"]) == ("headerAuth", "responseNode")
    assert hook["credentials"] == {"httpHeaderAuth": {"id": "slCredExtPracc01", "name": "Extension PRACC"}}
    responds = {n for n, x in nodes.items() if x["type"] == "n8n-nodes-base.respondToWebhook"}
    out = lambda src, i: [t["node"] for t in wf["connections"][src]["main"][i]]  # noqa: E731
    assert responds & set(out("Étape ?", 1))                # import
    assert responds & set(out("Calme ?", 0))                # pause du backup
    assert responds & set(out("Session expirée ?", 0))      # session expirée
    assert responds & set(out("Étape ?", 2))                # calendrier
    assert out("Étape ?", 3) == ["Sightline : démos FACEIT"] and out("Sightline : démos FACEIT", 0) == ["Répondre · démos FACEIT"]
    assert responds & set(out("Sightline : liens FACEIT", 0))  # liens FACEIT
    for name in ("Sightline : démos FACEIT", "Sightline : liens FACEIT"):  # Sightline en panne : l'extension a sa réponse
        assert nodes[name]["onError"] == "continueRegularOutput"
    assert out("À récupérer (3 max)", 0) == ["Répondre · à récupérer"]
    assert "httpCustomAuth" not in json.dumps(wf)           # plus aucun cookie PRACC côté serveur


def test_w2_claude_without_thinking():
    # Haiku 5.5 raisonne si rien n'est dit, et le résumé (600 jetons au plus) sortait vide le 23/10
    nodes = json.loads((N8N / "workflows" / "w2-discord.json").read_text(encoding="utf-8"))["nodes"]
    claude = next(n for n in nodes if n["type"] == "@n8n/n8n-nodes-langchain.lmChatAnthropic")
    assert claude["parameters"]["options"]["thinkingMode"] == "disabled"


def test_w4_form_protected_and_keeps_no_file():
    # formulaire ouvert sur Internet : identifiant d'équipe obligatoire ; ni exécution ni démo de 300 Mo gardées
    wf = json.loads((N8N / "workflows" / "w4-formulaire.json").read_text(encoding="utf-8"))
    form = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.formTrigger")
    assert form["parameters"]["authentication"] == "basicAuth"
    assert form["parameters"]["options"]["path"] == "import-demo" and "path" not in form["parameters"]  # ignoré en 2.6
    assert form["credentials"] == {"httpBasicAuth": {"id": "slCredFormBasic1", "name": "Formulaire d'import"}}
    assert (wf["settings"]["saveDataSuccessExecution"], wf["settings"]["saveDataErrorExecution"]) == ("none", "none")
    send = next(n for n in wf["nodes"] if n["name"] == "Vers Sightline")
    assert send["parameters"]["url"].endswith("/api/integrations/upload")
    assert "N8N_FORMDATA_FILE_SIZE_MAX" in (N8N / "compose.yaml").read_text(encoding="utf-8")


def test_w1_import_continues_on_error():
    # un import refusé ne doit pas arrêter les autres démos du tour ; la lecture des déjà-importés reste stricte
    nodes = {n["name"]: n for n in json.loads((N8N / "workflows" / "w1-pracc.json").read_text(encoding="utf-8"))["nodes"]}
    assert nodes["Importer dans Sightline"].get("onError") == "continueRegularOutput"
    assert "onError" not in nodes["Sightline : déjà importés ?"]


def test_credentials_template_is_empty(creds):
    for c in creds.values():
        if c["type"] == "httpCustomAuth":
            values = list(json.loads(c["data"]["json"])["headers"].values())
        else:
            values = [v for k, v in c["data"].items() if k in ("value", "secret", "apiKey", "webhookUri", "user", "password")]
        assert values and all(v == "" for v in values), c["name"]
