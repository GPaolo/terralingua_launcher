import json
import sys

import pytest
import yaml
from fastapi.testclient import TestClient

from terralingua_launcher import content, presets, server

CONTENT_FIELDS = {"agent.personas_path": {}, "agent.scenario_specific_instructions": {}, "env.init_artifacts_path": {}}


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
    assert content.list_items(tmp_path, "artifacts") == [
        {"name": "village", "path": "launcher_content/artifacts/village", "folder": "launcher_content/artifacts", "deletable": True},
    ]
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
        {"name": "watchers", "path": "launcher_content/personas/watchers.json", "folder": "launcher_content/personas", "deletable": True},
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


def test_listing_scans_the_given_folders_by_content(tmp_path, client):
    scen = tmp_path / "scen"
    (scen / "seeds").mkdir(parents=True)
    (scen / "viewer").mkdir()
    (scen / "personas.json").write_text('[{"persona": "You heal.", "role": "healer"}]')
    (scen / "extra.json").write_text('["You farm."]')
    (scen / "notes.json").write_text('{"not": "a list"}')
    (scen / "seeds" / "a.json").write_text('[{"name": "a", "art_type": "text", "payload": "x", "pose": [1, 1]}]')
    (scen / "viewer" / "data.json").write_text('{"rows": []}')
    content.write_item(tmp_path, "personas", "watchers", [{"persona": "You watch."}])
    personas = content.list_items(tmp_path, "personas", ["scen", "scen"])
    assert personas == [
        {"name": "extra", "path": "scen/extra.json", "folder": "scen", "deletable": False},
        {"name": "personas", "path": "scen/personas.json", "folder": "scen", "deletable": False},
        {"name": "watchers", "path": "launcher_content/personas/watchers.json", "folder": "launcher_content/personas", "deletable": True},
    ]
    assert content.list_items(tmp_path, "artifacts", ["scen", ""]) == [
        {"name": "seeds", "path": "scen/seeds", "folder": "scen", "deletable": False},
    ]
    assert content.list_items(tmp_path, "personas", ["missing"]) == personas[2:]
    with pytest.raises(content.ContentError):
        content.list_items(tmp_path, "personas", ["../outside"])
    items = client.get("/api/content/personas", params=[("folder", "scen"), ("folder", "")]).json()["items"]
    assert [i["path"] for i in items] == ["scen/extra.json", "scen/personas.json", "launcher_content/personas/watchers.json"]
    assert client.get("/api/content/personas", params={"folder": "../outside"}).status_code == 400


def test_sources_follow_the_settings_that_name_the_files(tmp_path):
    scenario = tmp_path / "scen"
    scenario.mkdir()
    (scenario / "personas.json").write_text('[{"persona": "You heal.", "count": 1}]')
    (scenario / "instructions.md").write_text("Be kind.\n")
    content.write_item(tmp_path, "artifacts", "village", [])
    fields = {**CONTENT_FIELDS, "run.scenario_options.personas_path": {}, "run.scenario_options.burials": {}}
    values = {
        "agent.personas_path": None,
        "run.scenario_options.personas_path": "personas.json",
        "agent.scenario_specific_instructions": str(scenario / "instructions.md"),
        "env.init_artifacts_path": "launcher_content/artifacts/village",
    }
    found = content.sources(tmp_path, fields, values, scenario)
    assert found["personas"] == {
        "setting": "run.scenario_options.personas_path", "value": "personas.json", "builtin": None,
        "path": str(scenario / "personas.json"), "relative": "scen/personas.json",
        "exists": True, "inside": True, "base": "scen",
    }
    assert found["instructions"]["relative"] == "scen/instructions.md"
    assert found["instructions"]["text"] == "Be kind.\n"
    assert found["instructions"]["base"] == ""
    assert found["artifacts"]["exists"] and found["artifacts"]["files"] == ["artifacts.json"]
    # a scenario option whose package folder is unknown reads from the working directory, and gets absolute values
    option = content.source(tmp_path, "personas", fields, {"run.scenario_options.personas_path": "p.json"}, None)
    assert option["path"] == str(tmp_path / "p.json") and option["base"] is None and not option["exists"]


def test_sources_without_files_and_with_builtin_names(tmp_path):
    values = {"agent.personas_path": None, "agent.scenario_specific_instructions": "none", "env.init_artifacts_path": "seeds"}
    found = content.sources(tmp_path, CONTENT_FIELDS, values, None)
    assert found["personas"]["value"] is None and found["personas"]["setting"] == "agent.personas_path"
    assert found["instructions"]["builtin"] == "none" and found["instructions"]["path"] is None
    assert found["artifacts"]["path"] == str(tmp_path / "seeds")
    assert found["artifacts"]["relative"] == "seeds" and found["artifacts"]["inside"] and not found["artifacts"]["exists"]
    outside = content.source(tmp_path, "personas", CONTENT_FIELDS, {"agent.personas_path": "/no/where/p.json"}, None)
    assert outside["path"] == "/no/where/p.json" and outside["relative"] is None and not outside["inside"]


def test_files_are_read_and_written_by_path(tmp_path):
    folder = tmp_path / "scen"
    folder.mkdir()
    (folder / "personas.json").write_text('[{"persona": "You heal."}]')
    found = content.read_path(tmp_path, "personas", "scen/personas.json")
    assert found == {"name": "personas", "path": "scen/personas.json", "data": [{"persona": "You heal."}], "writable": True}
    personas = [{"persona": "You heal.", "count": 2}]
    assert content.write_path(tmp_path, "personas", "scen/personas.json", personas) == {"name": "personas", "path": "scen/personas.json"}
    assert json.loads((folder / "personas.json").read_text()) == personas
    (folder / "seeds").mkdir()
    (folder / "seeds" / "a.json").write_text('[{"name": "a"}]')
    (folder / "seeds" / "b.json").write_text('{"name": "b"}')
    seeds = content.read_path(tmp_path, "artifacts", "scen/seeds")
    assert seeds["data"] == [{"name": "a"}, {"name": "b"}] and seeds["files"] == ["a.json", "b.json"] and not seeds["writable"]
    with pytest.raises(content.ContentError):
        content.write_path(tmp_path, "artifacts", "scen/seeds", [])
    content.write_path(tmp_path, "artifacts", "scen/new_seeds", [{"name": "c"}])
    assert json.loads((folder / "new_seeds" / "artifacts.json").read_text()) == [{"name": "c"}]
    with pytest.raises(FileNotFoundError):
        content.read_path(tmp_path, "personas", "scen/missing.json")
    for bad in ("../outside.json", "/etc/passwd"):
        with pytest.raises(content.ContentError):
            content.read_path(tmp_path, "personas", bad)
    with pytest.raises(content.ContentError):
        content.write_path(tmp_path, "personas", "scen/notes.txt", [])


def test_extra_json_files_are_read_and_written_by_path(tmp_path):
    (tmp_path / "scen").mkdir()
    assert content.write_json(tmp_path, "scen/centers.json", [{"pose": [1, 2]}]) == {"name": "centers", "path": "scen/centers.json"}
    assert json.loads((tmp_path / "scen" / "centers.json").read_text()) == [{"pose": [1, 2]}]
    found = content.read_json(tmp_path, "scen/centers.json")
    assert found == {"name": "centers", "path": "scen/centers.json", "data": [{"pose": [1, 2]}], "writable": True}
    # any JSON value, not only the lists the content kinds hold
    content.write_json(tmp_path, "scen/centers.json", {"beds": 9})
    assert content.read_json(tmp_path, "scen/centers.json")["data"] == {"beds": 9}
    with pytest.raises(FileNotFoundError):
        content.read_json(tmp_path, "scen/missing.json")
    for bad in ("../outside.json", "/etc/passwd.json", "scen/notes.txt", "scen"):
        with pytest.raises(content.ContentError):
            content.write_json(tmp_path, bad, [])


def test_referencing_finds_the_settings_that_name_a_file(tmp_path):
    (tmp_path / "pack").mkdir()
    (tmp_path / "pack" / "centers.json").touch()
    (tmp_path / "personas.json").touch()
    values = {
        "run.scenario_options.health_centers_path": "centers.json",
        "agent.personas_path": "personas.json",
        "run.scenario_options.beds": 9,
        "agent.genome": "ocean_5",
    }
    scenario = tmp_path / "pack"
    assert content.referencing(tmp_path, values, scenario, "pack/centers.json") == ["run.scenario_options.health_centers_path"]
    assert content.referencing(tmp_path, values, scenario, "personas.json") == ["agent.personas_path"]
    # an absolute value and a core setting point from the working directory
    values["agent.personas_path"] = str(tmp_path / "personas.json")
    assert content.referencing(tmp_path, values, scenario, "personas.json") == ["agent.personas_path"]
    assert content.referencing(tmp_path, values, None, "pack/centers.json") == []


def test_rebase_paths_makes_core_content_paths_relative_to_the_preset(tmp_path):
    config = {
        "agent": {
            "scenario_specific_instructions": str(tmp_path / "scen" / "instructions.md"),
            "personas_path": "launcher_content/personas/x.json",
        },
        "env": {"init_artifacts_path": "/elsewhere/seeds", "grid_size": 9},
        "run": {"scenario_options": {"personas_path": "personas.json"}},
    }
    out = content.rebase_paths(config, tmp_path, tmp_path / "scen")
    assert out["agent"] == {"scenario_specific_instructions": "instructions.md", "personas_path": "../launcher_content/personas/x.json"}
    assert out["env"] == {"init_artifacts_path": "/elsewhere/seeds", "grid_size": 9}
    assert out["run"] == config["run"]
    assert config["agent"]["scenario_specific_instructions"].startswith(str(tmp_path))
    builtin = {"agent": {"scenario_specific_instructions": "base", "personas_path": None}}
    assert content.rebase_paths(builtin, tmp_path, tmp_path) == builtin


def test_rebase_paths_restores_every_path_the_source_preset_had_relative(tmp_path):
    scen = tmp_path / "scen"
    scen.mkdir()
    (scen / "servers.json").write_text("{}")
    raw = {"run": {"external_servers_config": "servers.json", "exp_name": "x"}, "agent": {"scenario_specific_instructions": "instructions.md"}}
    requested = {
        "run": {"external_servers_config": str(scen / "servers.json"), "exp_name": "x", "max_ts": 5},
        "agent": {"scenario_specific_instructions": str(scen / "instructions.md"), "personas_path": "launcher_content/personas/x.json"},
    }
    beside = content.rebase_paths(requested, tmp_path, scen, raw, scen)
    assert beside["run"] == {"external_servers_config": "servers.json", "exp_name": "x", "max_ts": 5}
    assert beside["agent"] == {"scenario_specific_instructions": "instructions.md", "personas_path": "../launcher_content/personas/x.json"}
    root = content.rebase_paths(requested, tmp_path, tmp_path, raw, scen)
    assert root["run"]["external_servers_config"] == "scen/servers.json"
    assert root["agent"] == {"scenario_specific_instructions": "scen/instructions.md", "personas_path": "launcher_content/personas/x.json"}


def test_write_path_keeps_the_single_file_of_a_folder_and_refuses_escapes(tmp_path):
    seeds = tmp_path / "seeds"
    seeds.mkdir()
    (seeds / "signs.json").write_text('[{"name": "a", "art_type": "text", "payload": "x", "pose": [1, 1]}]')
    content.write_path(tmp_path, "artifacts", "seeds", [{"name": "b", "art_type": "text", "payload": "y", "pose": [2, 2]}])
    assert [p.name for p in seeds.iterdir()] == ["signs.json"]
    assert json.loads((seeds / "signs.json").read_text())[0]["name"] == "b"
    outside = tmp_path.parent / f"{tmp_path.name}_outside.json"
    outside.write_text("[]")
    try:
        (tmp_path / "linked").mkdir()
        (tmp_path / "linked" / "set.json").symlink_to(outside)
        with pytest.raises(content.ContentError):
            content.write_path(tmp_path, "artifacts", "linked", [])
        assert outside.read_text() == "[]"
    finally:
        outside.unlink()
    with pytest.raises(content.ContentError):
        content.write_path(tmp_path, "instructions", "scen.py", "print(1)")
    assert content.write_path(tmp_path, "instructions", "notes/intro.md", "Hi\n")["path"] == "notes/intro.md"


def test_paths_are_taken_as_terralingua_reads_them(tmp_path):
    assert content.resolve(tmp_path, "agent.personas_path", "~/p.json", None) == tmp_path / "~/p.json"
    (tmp_path / "intro").write_text("Hi")
    assert not content.is_builtin_name(tmp_path, "instructions", "intro")
    assert content.is_builtin_name(tmp_path, "instructions", "base")
    found = content.source(tmp_path, "instructions", CONTENT_FIELDS, {"agent.scenario_specific_instructions": "intro"}, None)
    assert found["builtin"] is None and found["exists"] and found["text"] == "Hi"


def test_preset_text_keeps_short_lists_on_one_line():
    config = {"run": {"scenario_options": {"health_center": {"pose": [25, 25]}}}, "env": {"zones": [{"a": 1}]}}
    text = presets.text("ebola", "A sickness.", config)
    assert "pose: [25, 25]" in text
    assert "- a: 1" in text
    assert yaml.safe_load(text) == {"name": "ebola", "description": "A sickness.", "config": config}


def test_file_routes(client, tmp_path):
    (tmp_path / "scen").mkdir()
    (tmp_path / "scen" / "personas.json").write_text('[{"persona": "You heal."}]')
    found = client.get("/api/files/personas", params={"path": "scen/personas.json"}).json()
    assert found["data"] == [{"persona": "You heal."}] and found["path"] == "scen/personas.json"
    body = {"path": "scen/personas.json", "data": [{"persona": "You farm.", "count": 3}]}
    assert client.put("/api/files/personas", json=body).json() == {"name": "personas", "path": "scen/personas.json"}
    assert json.loads((tmp_path / "scen" / "personas.json").read_text()) == body["data"]
    assert client.get("/api/files/personas", params={"path": "scen/missing.json"}).status_code == 404
    assert client.get("/api/files/personas", params={"path": "../outside.json"}).status_code == 400
    assert client.put("/api/files/personas", json={"data": []}).status_code == 400
    assert client.get("/api/files/nothing", params={"path": "x"}).status_code == 400
