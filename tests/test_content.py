import json
import sys

import pytest
from fastapi.testclient import TestClient

from terralingua_launcher import content, server


@pytest.fixture
def client(tmp_path):
    with TestClient(server.create_app(tmp_path, sys.executable, tmp_path / "state.json")) as c:
        yield c


def test_artifact_sets_live_in_their_own_folder(tmp_path):
    entries = [{"name": "sign", "art_type": "text", "payload": "Hello", "pose": [1, 2]}]
    assert content.write_item(tmp_path, "artifacts", "village", entries) == {
        "name": "village", "path": "launcher_content/artifacts/village",
    }
    assert json.loads((tmp_path / "launcher_content/artifacts/village/artifacts.json").read_text()) == entries
    assert content.list_items(tmp_path, "artifacts") == [{"name": "village", "path": "launcher_content/artifacts/village"}]
    assert content.read_item(tmp_path, "artifacts", "village")["data"] == entries
    content.delete_item(tmp_path, "artifacts", "village")
    assert content.list_items(tmp_path, "artifacts") == []


def test_persona_lists_and_instruction_texts_are_single_files(tmp_path):
    personas = [{"persona": "You are a healer.", "name": "Ada", "count": 2}]
    assert content.write_item(tmp_path, "personas", "healers", personas)["path"] == "launcher_content/personas/healers.json"
    assert content.write_item(tmp_path, "instructions", "calm", "Stay calm.\n")["path"] == "launcher_content/instructions/calm.md"
    assert content.read_item(tmp_path, "personas", "healers")["data"] == personas
    assert content.read_item(tmp_path, "instructions", "calm")["data"] == "Stay calm.\n"
    assert [i["name"] for i in content.list_items(tmp_path, "instructions")] == ["calm"]


@pytest.mark.parametrize("kind, name, data", [
    ("artifacts", "x", {"not": "a list"}),
    ("personas", "x", "text"),
    ("instructions", "x", ["list"]),
    ("artifacts", "../escape", []),
    ("artifacts", "-dash", []),
    ("artifacts", "", []),
    ("unknown", "x", []),
])
def test_bad_kinds_names_and_payloads_are_refused(tmp_path, kind, name, data):
    with pytest.raises(content.ContentError):
        content.write_item(tmp_path, kind, name, data)
    assert not (tmp_path / "launcher_content").exists()


def test_content_routes(client, tmp_path):
    assert client.get("/api/content/personas").json() == {"items": []}
    body = {"data": [{"persona": "You watch the sky.", "count": 1}]}
    assert client.put("/api/content/personas/watchers", json=body).status_code == 200
    assert client.get("/api/content/personas").json()["items"] == [
        {"name": "watchers", "path": "launcher_content/personas/watchers.json"},
    ]
    assert client.get("/api/content/personas/watchers").json()["data"] == body["data"]
    assert client.put("/api/content/personas/bad", json={"data": "no"}).status_code == 400
    assert client.put("/api/content/personas/bad", json={}).status_code == 400
    assert client.get("/api/content/personas/missing").status_code == 404
    assert client.get("/api/content/nothing").status_code == 400
    assert client.delete("/api/content/personas/watchers").json() == {"ok": True}
    assert client.delete("/api/content/personas/watchers").status_code == 404


def test_artifact_types_come_from_the_target(client):
    types = {t["name"]: t for t in client.get("/api/artifact_types").json()["types"]}
    assert "text" in types
    assert set(types["text"]) == {"name", "description", "creatable", "params"}
    assert all(isinstance(t["params"], list) for t in types.values())
