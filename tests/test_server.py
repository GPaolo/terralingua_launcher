"""The launcher server against a real TerraLingua installation.

The interpreter running the tests must have terralingua installed. The
working directory defaults to the current folder; set TL_LAUNCHER_TEST_WORKDIR
to a TerraLingua checkout to also cover a preset with a scenario (ebola).
"""

import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from terralingua_launcher import server, store, target

WORKDIR = Path(os.environ.get("TL_LAUNCHER_TEST_WORKDIR", ".")).resolve()
INSTALLED = target.version(sys.executable, WORKDIR) is not None
PRESETS = {p["name"] for p in target.presets(sys.executable, WORKDIR)} if INSTALLED else set()

pytestmark = pytest.mark.skipif(not INSTALLED, reason="terralingua is not installed in this interpreter")
needs_ebola = pytest.mark.skipif("ebola" not in PRESETS, reason="the ebola preset is not in the working directory")

FAKE_RUN = 'if [ "$1" = "-m" ] && [ "$2" = "terralingua" ]; then echo "fake run $@ mark=$TL_LAUNCHER_TEST_MARK"; {}; exit 0; fi\n'


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Keep the user's launcher settings untouched."""
    monkeypatch.setattr(store, "STATE_PATH", tmp_path / "state.json")


@pytest.fixture
def client():
    with TestClient(server.create_app(WORKDIR, sys.executable)) as c:
        yield c


def executable(path: Path, body: str) -> str:
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


@pytest.fixture
def fake_python(tmp_path):
    """An interpreter that answers config commands for real but only echoes a run."""
    return executable(tmp_path / "fake_python.sh", FAKE_RUN.format(":") + f'exec {sys.executable} "$@"\n')


@pytest.fixture
def sleeping_python(tmp_path):
    """Like fake_python, but a run keeps going until it is stopped."""
    return executable(tmp_path / "sleeping_python.sh", FAKE_RUN.format("sleep 60") + f'exec {sys.executable} "$@"\n')


@pytest.fixture
def workdir(tmp_path):
    path = tmp_path / "work"
    path.mkdir()
    return path


def wait_until_done(client, proc_id, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        proc = next(p for p in client.get("/api/procs").json()["procs"] if p["id"] == proc_id)
        if proc["status"] != "running":
            return proc
        time.sleep(0.2)
    raise AssertionError("the process did not finish")


def test_settings_describe_the_target(client):
    data = client.get("/api/settings").json()
    assert data["workdir"] == str(WORKDIR)
    assert data["python"] == sys.executable
    assert data["workdir_ok"] and data["python_ok"]
    assert data["terralingua_version"]
    assert set(data["keys"]) == set(server.KEY_VARS)
    assert data["last"] == {}


def test_settings_reject_missing_paths(client):
    assert client.post("/api/settings", json={"workdir": "/no/such/folder"}).status_code == 400
    assert client.post("/api/settings", json={"python": "/no/such/python"}).status_code == 400
    assert client.get("/api/settings").json()["python"] == sys.executable


def test_settings_stay_unchanged_when_the_interpreter_is_rejected(client, tmp_path):
    script = executable(tmp_path / "python", "exit 1\n")
    response = client.post("/api/settings", json={"python": script})
    assert response.status_code == 400
    assert "terralingua" in response.json()["detail"]
    assert client.get("/api/settings").json()["python"] == sys.executable
    assert client.get("/api/schema").status_code == 200


def test_settings_accept_an_interpreter_name_found_on_the_path(client, fake_python, monkeypatch):
    monkeypatch.setenv("PATH", str(Path(fake_python).parent) + os.pathsep + os.environ["PATH"])
    data = client.post("/api/settings", json={"python": Path(fake_python).name}).json()
    assert data["python"] == fake_python
    assert data["python_ok"]


def test_state_is_remembered(client):
    body = {"preset": "core", "overrides": {"env.grid_size": 7}, "resume": True}
    assert client.post("/api/state", json=body).json() == {"ok": True}
    assert client.get("/api/settings").json()["last"] == body
    assert json.loads(store.STATE_PATH.read_text())["last"] == body


def test_cross_origin_requests_are_refused(client):
    assert client.post("/api/state", json={}, headers={"Origin": "http://evil.example"}).status_code == 403
    assert client.post("/api/state", json={}, headers={"Origin": "http://testserver"}).status_code == 200


def test_presets_include_the_builtins(client):
    presets = {p["name"]: p for p in client.get("/api/presets").json()["presets"]}
    assert presets["core"]["location"] == "(built-in)"
    assert presets["grid_baseline"]["description"]


@needs_ebola
def test_presets_include_the_working_directory(client):
    presets = {p["name"]: p for p in client.get("/api/presets").json()["presets"]}
    assert presets["ebola"]["location"].endswith("ebola.preset.yaml")


def test_a_broken_preset_file_is_reported_as_a_request_error(workdir):
    (workdir / "bad.preset.yaml").write_text("name: [unclosed\n")
    with TestClient(server.create_app(workdir, sys.executable)) as client:
        response = client.get("/api/presets")
        assert response.status_code == 400
        assert "bad.preset.yaml" in response.json()["detail"]
        body = {"name": "Other", "preset": "core", "overrides": {}}
        assert client.post("/api/presets", json=body).status_code == 400


def test_schema_lists_grouped_fields(client):
    data = client.get("/api/schema").json()
    assert data["fields"]["env.grid_size"]["aliases"] == ["grid_size"]
    assert data["fields"]["env.grid_size"]["group"] == "World"
    grouped = {path for group in data["groups"] for path in group["fields"]}
    assert grouped == set(data["fields"])
    assert data.get("scenario") is None


@needs_ebola
def test_schema_with_a_preset_describes_its_scenario(client):
    data = client.get("/api/schema", params={"preset": "ebola"}).json()
    scenario = data["scenario"]
    assert scenario["module"] == "scenarios.ebola"
    assert scenario["fields"]["run.scenario_options.burials"]["type"] == "bool"
    assert "run.scenario_options.health_center.radius" in scenario["fields"]


def test_schema_rejects_an_unknown_preset(client):
    response = client.get("/api/schema", params={"preset": "no_such_preset"})
    assert response.status_code == 400
    assert "no_such_preset" in response.json()["detail"]


def test_evaluate_reports_field_states(client):
    data = client.post("/api/evaluate", json={"preset": None, "overrides": {"env.world_type": "graph"}}).json()
    assert data["valid"]
    assert data["fields"]["env.grid_size"] == {"active": False, "reason": "Requires a grid world."}
    assert data["fields"]["env.graph.topology"]["active"]
    assert data["inactive_values"]["env.grid_size"] == 50


def test_evaluate_reports_errors(client):
    data = client.post("/api/evaluate", json={"preset": "core", "overrides": {"run.max_ts": "abc"}}).json()
    assert not data["valid"]
    assert data["fields"] == {}
    [error] = [d for d in data["diagnostics"] if d["severity"] == "error"]
    assert error["field"] == "run.max_ts"


def test_overrides_must_be_an_object(client):
    for route in ("/api/evaluate", "/api/preview", "/api/launch"):
        response = client.post(route, json={"preset": "core", "overrides": [1, 2]})
        assert response.status_code == 400, route
        assert "overrides" in response.json()["detail"]


@needs_ebola
def test_evaluate_merges_scenario_options(client):
    overrides = {
        "run.scenario_options.burials": False,
        "run.scenario_options.health_center.radius": 3,
        "run.scenario_options": {"lifespan": 20},
    }
    data = client.post("/api/evaluate", json={"preset": "ebola", "overrides": overrides}).json()
    assert data["valid"], data["diagnostics"]
    options = data["resolved"]["run"]["scenario_options"]
    assert options["burials"] is False
    assert options["health_center"]["radius"] == 3
    assert options["lifespan"] == 20
    assert options["ppe_role"] == "health_worker"  # untouched preset values stay


@needs_ebola
def test_preview_builds_the_terralingua_command(client):
    body = {
        "preset": "ebola",
        "overrides": {"env.grid_size": 12, "run.scenario_options.burials": False},
        "resume": True,
    }
    data = client.post("/api/preview", json=body).json()
    assert data["argv"] == [
        "ebola", "--scenario_options", '{"burials": false}', "--grid_size", "12", "--resume",
    ]
    assert data["cmd"].startswith(sys.executable + " -m terralingua ebola ")


@pytest.mark.parametrize(
    "preset, overrides",
    [
        (
            "core",
            {
                "env.grid_size": 12, "env.world_type": "graph", "env.graph.seed": 7, "run.seed": 3,
                "run.max_ts": -1, "env.food_zones": None, "run.ports": [8000, 8001],
                "agent.use_colors": False, "env.energy_death": False, "run.exp_name": "round trip",
            },
        ),
        pytest.param(
            "ebola",
            {"run.scenario_options.burials": False, "run.scenario_options.health_center.radius": 3, "env.grid_size": 9},
            marks=needs_ebola,
        ),
    ],
)
def test_the_previewed_command_composes_the_evaluated_configuration(client, preset, overrides):
    """TerraLingua's own parser and composer turn the launcher's argv into the configuration evaluate saw."""
    body = {"preset": preset, "overrides": overrides}
    evaluated = client.post("/api/evaluate", json=body).json()
    assert evaluated["valid"], evaluated["diagnostics"]
    argv = client.post("/api/preview", json=body).json()["argv"]
    code = (
        "import json, sys\n"
        "from terralingua.config.cli import parse_argv\n"
        "from terralingua.config.compose import compose\n"
        "preset, overrides, resume = parse_argv(json.loads(sys.argv[1]))\n"
        "print(json.dumps(compose(preset, overrides).to_json()))\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", code, json.dumps(argv)], cwd=WORKDIR, capture_output=True, text=True, check=True
    )
    assert json.loads(out.stdout) == evaluated["resolved"]


def test_save_preset_writes_a_file_the_target_discovers(workdir):
    with TestClient(server.create_app(workdir, sys.executable)) as client:
        body = {"name": "My run", "description": "Small grid.", "preset": "core", "overrides": {"env.grid_size": 7}}
        response = client.post("/api/presets", json=body)
        assert response.status_code == 200, response.json()
        path = Path(response.json()["path"])
        assert path == workdir / "My_run.preset.yaml"
        data = yaml.safe_load(path.read_text())
        assert data["name"] == "My run"
        assert data["description"] == "Small grid."
        assert data["config"]["env"]["grid_size"] == 7
        names = {p["name"] for p in client.get("/api/presets").json()["presets"]}
        assert "My run" in names
        assert client.post("/api/presets", json=body).status_code == 400
        for name in ("", "   ", "-dash", "???"):
            assert client.post("/api/presets", json={**body, "name": name}).status_code == 400, name
        bad = {**body, "name": "Broken", "overrides": {"run.max_ts": "abc"}}
        response = client.post("/api/presets", json=bad)
        assert response.status_code == 400
        assert "not valid" in response.json()["detail"]
        assert sorted(p.name for p in workdir.glob("*.preset.yaml")) == ["My_run.preset.yaml"]


def test_fs_completes_folders_and_executables(client, tmp_path):
    (tmp_path / "alpha").mkdir()
    (tmp_path / "notes.txt").write_text("x")
    exe = executable(tmp_path / "run.sh", "")
    paths = client.get("/api/fs", params={"prefix": f"{tmp_path}/"}).json()["paths"]
    assert f"{tmp_path}/alpha/" in paths
    assert exe in paths
    assert str(tmp_path / "notes.txt") not in paths
    only_dirs = client.get("/api/fs", params={"prefix": f"{tmp_path}/a", "dirs_only": "true"}).json()["paths"]
    assert only_dirs == [f"{tmp_path}/alpha/"]


def test_launch_runs_the_command_in_the_working_directory(workdir, fake_python):
    (workdir / ".env").write_text("TL_LAUNCHER_TEST_MARK=hello\n")
    with TestClient(server.create_app(workdir, fake_python)) as client:
        body = {"preset": "core", "overrides": {"env.grid_size": 9, "run.exp_name": "trial"}, "resume": False}
        proc = client.post("/api/launch", json=body).json()["proc"]
        assert proc["label"] == "trial"
        assert proc["cmd"] == f"{fake_python} -m terralingua core --grid_size 9 --exp_name trial"
        finished = wait_until_done(client, proc["id"])
        assert finished["status"] == "finished"
        log = client.get(f"/api/procs/{proc['id']}/log").json()
        assert "fake run -m terralingua core --grid_size 9 --exp_name trial mark=hello" in log["text"]
        assert log["status"] == "finished"
        again = client.get(f"/api/procs/{proc['id']}/log", params={"offset": log["offset"]}).json()
        assert again == {"offset": log["offset"], "text": "", "status": "finished"}
        assert Path(proc["log_path"]).is_relative_to(workdir / "logs" / "_launcher")
        assert client.post(f"/api/procs/{proc['id']}/stop").status_code == 404
        assert client.get("/api/procs/999/log").status_code == 404
        assert client.get("/api/settings").json()["last"] == body


def test_switching_the_working_directory_changes_the_run_environment(workdir, tmp_path, fake_python):
    (workdir / ".env").write_text("TL_LAUNCHER_TEST_MARK=first\n")
    other = tmp_path / "other"
    other.mkdir()
    with TestClient(server.create_app(workdir, fake_python)) as client:
        assert client.post("/api/settings", json={"workdir": str(other)}).status_code == 200
        proc = client.post("/api/launch", json={"preset": "core", "overrides": {}}).json()["proc"]
        wait_until_done(client, proc["id"])
        text = client.get(f"/api/procs/{proc['id']}/log").json()["text"]
        assert "mark=\n" in text
        assert Path(proc["log_path"]).is_relative_to(other)


def test_two_launches_in_the_same_second_get_separate_logs(workdir, fake_python):
    with TestClient(server.create_app(workdir, fake_python)) as client:
        body = {"preset": "core", "overrides": {}}
        first = client.post("/api/launch", json=body).json()["proc"]
        second = client.post("/api/launch", json=body).json()["proc"]
        assert first["log_path"] != second["log_path"]


def test_stop_ends_a_running_process(workdir, sleeping_python):
    with TestClient(server.create_app(workdir, sleeping_python)) as client:
        proc = client.post("/api/launch", json={"preset": "core", "overrides": {}}).json()["proc"]
        assert proc["status"] == "running"
        assert client.post(f"/api/procs/{proc['id']}/stop").json() == {"ok": True}
        assert wait_until_done(client, proc["id"])["status"] == "stopped"


def test_launch_refuses_an_interpreter_that_cannot_run(workdir, tmp_path):
    script = tmp_path / "not_executable"
    script.write_text("#!/bin/sh\n")
    with TestClient(server.create_app(workdir, str(script))) as client:
        assert not client.get("/api/settings").json()["python_ok"]
        response = client.post("/api/launch", json={"preset": "core", "overrides": {}})
        assert response.status_code == 400
