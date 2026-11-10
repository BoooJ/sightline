# backend/tests/test_ai.py
import asyncio
import io
import json
import os

from app.ai import assistant
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_status_and_config(client, monkeypatch):
    c, tmp = client
    monkeypatch.delenv("SKYBOX_ANTHROPIC_API_KEY", raising=False)
    s = c.get("/api/ai/status").json()
    assert s["enabled"] is False and s["model"] == assistant.DEFAULT_MODEL["anthropic"] and s["can_configure"] is True
    assert c.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "Salut"}]}).status_code == 409
    assert c.put("/api/ai/config", json={"api_key": "pas-une-cle"}).status_code == 400
    assert c.put("/api/ai/config", json={"model": "inconnu"}).status_code == 400

    async def ok(_key):
        return True
    monkeypatch.setattr(assistant, "check_key", ok)
    s = c.put("/api/ai/config", json={"api_key": "sk-ant-test-0123456789abcdef", "model": "claude-sonnet-5-5"}).json()
    assert s["enabled"] is True and s["model"] == "claude-sonnet-5-5" and s["source"] == "app"
    assert "sk-ant" not in json.dumps(s)  # la clé n'est jamais renvoyée
    secrets = json.loads((tmp / "data" / "secrets.json").read_text(encoding="utf-8"))
    assert secrets["anthropic_api_key"] == "sk-ant-test-0123456789abcdef"
    # la variable d'environnement l'emporte
    monkeypatch.setenv("SKYBOX_ANTHROPIC_API_KEY", "sk-ant-env")
    assert c.get("/api/ai/status").json()["source"] == "env"
    monkeypatch.delenv("SKYBOX_ANTHROPIC_API_KEY")
    s = c.put("/api/ai/config", json={"clear_key": True}).json()
    assert s["enabled"] is False
    assert os.path.exists(tmp / "data" / "secrets.json")


def test_tool_calls_the_api_read_only(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    app = c.app
    out = json.loads(asyncio.run(assistant.call_api(app, {}, "/api/matches", {})))
    assert out and out[0]["map_name"] == "de_nuke"
    mid = out[0]["id"]
    stats = asyncio.run(assistant.call_api(app, {}, f"/api/matches/{mid}/stats", {"side": "CT"}))
    assert "rating" in stats
    # routes hors liste blanche ou en écriture refusées
    assert "non autorisée" in asyncio.run(assistant.call_api(app, {}, "/api/demos", {}))
    assert "non autorisée" in asyncio.run(assistant.call_api(app, {}, "/api/ai/config", {}))
    assert not assistant.allowed("/api/matches/1/labels")
    # réponse volumineuse tronquée, trajectoires retirées
    big = asyncio.run(assistant.call_api(app, {}, f"/api/matches/{mid}/analysis", {}))
    assert len(big) <= assistant.MAX_RESULT_CHARS + 200
    assert assistant.step_label("/api/rounds/search", {"map": "de_nuke"}) == "Recherche de rounds (map=de_nuke)"


class _Block:
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def model_dump(self, exclude_none=True):
        return {k: v for k, v in self.__dict__.items() if v is not None}


class _Stream:
    def __init__(self, final, texts):
        self.final, self.texts = final, texts

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    @property
    def text_stream(self):
        async def gen():
            for t in self.texts:
                yield t
        return gen()

    async def get_final_message(self):
        return self.final


def test_chat_loop_with_fake_model(client, monkeypatch):
    import anthropic

    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    seen = []
    usage = _Block(input_tokens=10, output_tokens=5)
    turns = [
        _Block(stop_reason="tool_use", usage=usage, content=[_Block(type="text", text="Je regarde."),
               _Block(type="tool_use", id="t1", name="sightline_api", input={"path": "/api/matches", "params": {}})]),
        _Block(stop_reason="end_turn", usage=usage, content=[_Block(type="text", text="FaZe a perdu 10-13 [Match](/matches/1).")]),
    ]

    class FakeMessages:
        def stream(self, **kw):
            seen.append(kw["messages"])
            final = turns[len(seen) - 1]
            return _Stream(final, [b.text for b in final.content if b.type == "text"])

    class FakeClient:
        def __init__(self, api_key):
            assert api_key == "sk-ant-x"
            self.messages = FakeMessages()

    monkeypatch.setattr(anthropic, "AsyncAnthropic", FakeClient)
    monkeypatch.setenv("SKYBOX_ANTHROPIC_API_KEY", "sk-ant-x")
    r = c.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "Résume le dernier match"}], "context": {"me": "123"}})
    assert r.status_code == 200
    evs = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    assert [e["type"] for e in evs if e["type"] != "text"] == ["step", "done"]
    assert evs[-1]["usage"] == {"input": 20, "output": 10}
    assert "".join(e["text"] for e in evs if e["type"] == "text").endswith("[Match](/matches/1).")
    # le second appel contient le résultat de l'outil (données réelles de la bibliothèque)
    convo = seen[1]  # même liste que la conversation complète
    tool_result = next(m for m in convo if m["role"] == "user" and isinstance(m["content"], list))["content"][0]
    assert tool_result["type"] == "tool_result" and "de_nuke" in tool_result["content"]


def test_gemini_key_selects_gemini(client, monkeypatch):
    c, tmp = client
    monkeypatch.delenv("SKYBOX_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("SKYBOX_GEMINI_API_KEY", raising=False)

    async def ok(_key):
        return True
    monkeypatch.setattr(assistant, "check_key", ok)
    s = c.put("/api/ai/config", json={"api_key": "AQ.fake-gemini-key-0123456789"}).json()
    assert s["enabled"] and s["provider"] == "gemini" and s["model"] == "gemini-flash-latest" and s["providers"] == ["gemini"]
    secrets = json.loads((tmp / "data" / "secrets.json").read_text(encoding="utf-8"))
    assert secrets["gemini_api_key"].startswith("AQ.") and "anthropic_api_key" not in secrets
    # un modèle Claude sans clé Anthropic : on reste sur Gemini
    s = c.put("/api/ai/config", json={"model": "claude-opus-5-5"}).json()
    assert s["provider"] == "gemini" and s["model"] == "gemini-flash-latest"
    assert assistant._parse_params("map=de_mirage&side=T") == {"map": "de_mirage", "side": "T"}
    assert assistant._parse_params({"a": 1}) == {"a": 1} and assistant._parse_params(None) == {}
