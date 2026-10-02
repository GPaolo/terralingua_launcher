import json
import sys

import pytest
from fastapi.testclient import TestClient

from terralingua_launcher import designer, server

CONTEXT = {
    "world_type": "grid",
    "init_agents": 4,
    "fields": {
        "env.init_agents": {"type": "int", "default": 20, "description": "Initial beings", "schema": {"minimum": 0}},
        "env.world_type": {"type": "str", "default": "grid", "description": "World", "schema": {"enum": ["grid", "graph"]}},
    },
    "values": {"env.init_agents": 4, "env.world_type": "grid"},
    "artifact_types": [{"name": "text", "description": "Text marker.", "creatable": True, "params": ["max_tokens"]}],
    "instructions_source": "none",
    "instructions_text": "",
}

GOOD = {
    "instructions": "A storm season has started.",
    "personas": [{"persona": "You are a healer.", "name": "Ada", "count": 1}, {"persona": "You farm.", "name": None, "count": 3}],
    "artifacts": [{"name": "old_sign", "art_type": "text", "payload": "Beware", "pose": [1, 2], "lifespan": -1, "movable": False, "params": {}}],
    "suggested_params": [{"path": "env.init_agents", "value": 12, "why": "More beings fill the village."}],
    "design_notes": "The text states the season. Two personas. One sign.",
}


def test_the_prompt_lists_the_world_the_types_and_the_settings():
    text = designer.user_prompt("A village in a storm season.", CONTEXT)
    assert "World type: grid. Initial beings: 4." in text
    assert "- text: Text marker. Parameters: max_tokens." in text
    assert '- env.world_type (str one of ["grid", "graph"]; now "grid"): World' in text
    assert "- env.init_agents (int from 0 to inf; now 4): Initial beings" in text
    assert "previous reply" not in text
    refined = designer.user_prompt("A village.", CONTEXT, previous=GOOD, feedback="Fewer farmers.")
    assert "Your previous reply" in refined and "Fewer farmers." in refined


def test_the_reply_is_read_fenced_or_bare():
    assert designer.parse_reply("Here it is:\n```json\n" + json.dumps(GOOD) + "\n```\nDone.") == GOOD
    assert designer.parse_reply(json.dumps(GOOD)) == GOOD
    with pytest.raises(ValueError):
        designer.parse_reply("no json here")
    with pytest.raises(ValueError):
        designer.parse_reply("[1, 2]")


def test_a_good_design_has_no_issues():
    assert designer.check_design(GOOD, CONTEXT) == []


def test_problems_are_named():
    bad = {
        "instructions": " ",
        "personas": [{"persona": ""}, {"persona": "You farm.", "count": 0}],
        "artifacts": [
            {"name": "Bad Name", "art_type": "gold", "payload": "", "pose": "x", "lifespan": -2, "movable": "yes", "params": []},
            {"name": "Bad Name", "art_type": "text", "payload": "ok", "pose": [1, 2]},
        ],
        "suggested_params": [{"path": "env.nothing", "value": 1}, {"path": "env.init_agents"}],
    }
    issues = designer.check_design(bad, CONTEXT)
    expected = [
        ("instructions", "instructions is empty"),
        ("personas", "persona 1 has no text"), ("personas", "persona 2 has an invalid count 0"),
        ("artifacts", "artifact names are not unique"), ("artifacts", "artifact 1 needs a snake_case name"),
        ("artifacts", "artifact 1 has an unknown type 'gold'"), ("artifacts", "artifact 1 has no payload"),
        ("artifacts", "artifact 1 needs a pose [row, col]"), ("artifacts", "artifact 1 has an invalid lifespan -2"),
        ("artifacts", "artifact 1 has an invalid movable value"), ("artifacts", "artifact 1 has params that are not an object"),
        ("artifacts", "artifact 2 needs a snake_case name"),
        ("suggested_params", "suggested setting 'env.nothing' does not exist"),
        ("suggested_params", "suggested setting env.init_agents has no value"),
    ]
    assert [(i["where"], i["message"]) for i in issues] == expected
    graph = {**CONTEXT, "world_type": "graph"}
    assert {"where": "artifacts", "message": "artifact 1 needs a node id as pose"} in designer.check_design(GOOD, graph)


def test_the_key_follows_the_model_provider():
    env = {"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "o"}
    assert designer.key_for("claude-opus-5-5", env) == "a"
    assert designer.key_for("gpt-5", env) == "o"
    assert designer.key_for("mistral/large", env) is None
    assert designer.key_for("claude-opus-5-5", {}) is None


def test_design_asks_the_model_once_and_checks_the_reply():
    calls = []

    def fake_complete(model, messages, api_key):
        calls.append((model, [m["role"] for m in messages], api_key))
        return json.dumps(GOOD)

    result = designer.design("A village.", CONTEXT, "test-model", "key", fake_complete)
    assert result == {"design": GOOD, "issues": []}
    assert calls == [("test-model", ["system", "user"], "key")]


def test_the_design_route_gathers_the_context_from_the_target(tmp_path):
    seen = {}

    def fake_complete(model, messages, api_key):
        seen["model"] = model
        seen["user"] = messages[1]["content"]
        return json.dumps(GOOD)

    app = server.create_app(tmp_path, sys.executable, tmp_path / "state.json", complete=fake_complete)
    with TestClient(app) as client:
        body = {
            "description": "A village in a storm season.", "preset": "core",
            "overrides": {"env.init_agents": 4, "env.min_agents": 0}, "model": "test-model",
        }
        result = client.post("/api/design", json=body).json()
        assert result["design"] == GOOD
        assert result["issues"] == []
        assert seen["model"] == "test-model"
        assert "World type: grid. Initial beings: 4." in seen["user"]
        assert "- text:" in seen["user"]
        assert "- env.grid_size (int" in seen["user"]
        assert client.post("/api/design", json={**body, "description": ""}).status_code == 400
        broken = {**body, "overrides": {"run.max_ts": "abc"}}
        assert client.post("/api/design", json=broken).status_code == 400


def test_a_bad_model_reply_is_a_gateway_error(tmp_path):
    app = server.create_app(tmp_path, sys.executable, tmp_path / "state.json", complete=lambda m, msgs, k: "sorry")
    with TestClient(app) as client:
        response = client.post("/api/design", json={"description": "x", "preset": "core", "overrides": {}})
        assert response.status_code == 502
        assert "valid JSON" in response.json()["detail"]
