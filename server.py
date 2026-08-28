"""FastAPI app for the TerraLingua launcher UI.

Independent of the target repo's code: parameters come from introspect.py run
with the target's own interpreter, prompts from an ast pass over its
prompt_templates.py, and runs from `python main.py ...` subprocesses. Point it
at any TerraLingua checkout via --repo / the header settings.
"""

import json
import os
import socket
import subprocess
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from terralingua_launcher import args as argsmod
from terralingua_launcher import designer, prompts, store
from terralingua_launcher.procs import ProcRegistry

STATIC_DIR = Path(__file__).parent / "static"
INTROSPECT = Path(__file__).parent / "introspect.py"

#: key env var -> litellm providers that key unlocks; drives both the header
#: chips and the model-list filter on the scenario tab
KEY_PROVIDERS = {
    "ANTHROPIC_API_KEY": ("anthropic",),
    "OPENAI_API_KEY": ("openai",),
    "GEMINI_API_KEY": ("gemini",),
    "AWS_BEARER_TOKEN_BEDROCK": ("bedrock", "bedrock_converse"),
}
KEY_VARS = tuple(KEY_PROVIDERS)


def _port_open(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((host, port)) == 0


def _load_repo_env(repo: Path) -> None:
    """Makes the repo's .env keys visible to the designer (litellm reads env)."""
    try:
        from dotenv import dotenv_values

        for k, v in (dotenv_values(repo / ".env") or {}).items():
            if v:
                os.environ.setdefault(k, v)
    except ImportError:
        pass


def create_app(repo: Path | None = None, python: str | None = None) -> FastAPI:
    app = FastAPI(title="TerraLingua Launcher")
    state = store.load_state()
    app.state.repo = Path(
        repo or state.get("repo") or store.detect_repo() or Path.cwd()
    )
    app.state.python = str(
        python or state.get("python") or store.default_python(app.state.repo)
    )
    app.state.viz_port = int(state.get("viz_port") or 8000)
    app.state.last_values = state.get("last_values") or {}
    app.state.last_model = state.get("last_model") or designer.DEFAULT_MODEL
    app.state.schema_cache = None  # (key, schema)
    app.state.procs = ProcRegistry()
    app.state.viz_lock = threading.Lock()
    _load_repo_env(app.state.repo)

    def persist():
        store.save_state(
            {
                "repo": str(app.state.repo),
                "python": app.state.python,
                "viz_port": app.state.viz_port,
                "last_values": app.state.last_values,
                "last_model": app.state.last_model,
            }
        )

    def repo_ok() -> bool:
        return store.looks_like_tl_repo(app.state.repo)

    #: every file the introspected schema draws from — choices and the model
    #: list live outside config.py, so all of them key the cache
    SCHEMA_SOURCES = (
        ("core", "experiment", "config.py"),
        ("core", "experiment", "llm_router.py"),
        ("core", "genome", "__init__.py"),
        ("core", "environment", "env.py"),
        ("core", "agents", "prompt_templates.py"),
    )

    def get_schema(refresh: bool = False) -> dict:
        mtimes = []
        for parts in SCHEMA_SOURCES:
            f = app.state.repo.joinpath(*parts)
            mtimes.append(f.stat().st_mtime if f.exists() else 0)
        key = (app.state.python, str(app.state.repo), tuple(mtimes))
        if not refresh and app.state.schema_cache and app.state.schema_cache[0] == key:
            return app.state.schema_cache[1]
        if not repo_ok():
            raise HTTPException(
                400, f"{app.state.repo} does not look like a TerraLingua repo"
            )
        try:
            out = subprocess.run(
                [app.state.python, str(INTROSPECT)],
                cwd=app.state.repo,
                capture_output=True,
                timeout=180,
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            raise HTTPException(500, f"introspection failed to run: {e}")
        stderr_tail = out.stderr.decode(errors="replace")[-2000:]
        if out.returncode != 0:
            raise HTTPException(
                500, f"introspection exited {out.returncode}: {stderr_tail}"
            )
        try:
            schema = json.loads(out.stdout.decode())
        except json.JSONDecodeError:
            raise HTTPException(
                500, f"introspection returned no JSON. stderr: {stderr_tail}"
            )
        if not schema.get("groups"):
            detail = "; ".join(schema.get("errors") or []) or stderr_tail
            raise HTTPException(500, f"introspection found no parameters: {detail}")
        app.state.schema_cache = (key, schema)  # only healthy schemas cached
        return schema

    def param_index(schema: dict) -> dict:
        return {p["name"]: p for g in schema.get("groups", []) for p in g["params"]}

    # ---------- settings ----------

    @app.get("/api/settings")
    def get_settings():
        return {
            "repo": str(app.state.repo),
            "python": app.state.python,
            "viz_port": app.state.viz_port,
            "repo_ok": repo_ok(),
            "python_ok": Path(app.state.python).is_file(),
            "keys": {k: bool(os.environ.get(k)) for k in KEY_VARS},
            "last_values": app.state.last_values,
            "last_model": app.state.last_model,
        }

    @app.post("/api/settings")
    def set_settings(body: dict):
        if body.get("repo"):
            repo = Path(body["repo"]).expanduser()
            if not store.looks_like_tl_repo(repo):
                raise HTTPException(
                    400, f"{repo} has no main.py / core/experiment/config.py"
                )
            app.state.repo = repo
            app.state.schema_cache = None
            _load_repo_env(repo)
        if body.get("python"):
            py = Path(body["python"]).expanduser()
            if not py.is_file():
                raise HTTPException(400, f"{py} not found")
            app.state.python = str(py)
            app.state.schema_cache = None
        if body.get("viz_port"):
            app.state.viz_port = int(body["viz_port"])
        persist()
        return get_settings()

    @app.get("/api/fs")
    def fs_complete(prefix: str = "", dirs_only: bool = False):
        """Path completion for the settings fields (repo / interpreter).
        Directory and executable names only, never file contents — those two
        fields exist to point anywhere on the local machine."""
        raw = prefix or "~/"
        p = Path(raw).expanduser()
        if raw.endswith("/"):
            base, partial = p, ""
        else:
            base, partial = p.parent, p.name
        out = []
        try:
            for e in sorted(base.iterdir()):
                name = e.name
                if partial and not name.lower().startswith(partial.lower()):
                    continue
                if name.startswith(".") and not partial.startswith("."):
                    continue
                if e.is_dir():
                    out.append(str(e) + "/")
                elif not dirs_only and os.access(e, os.X_OK):
                    out.append(str(e))
                if len(out) >= 50:
                    break
        except OSError:
            pass
        return {"paths": out}

    @app.post("/api/state")
    def set_state(body: dict):
        if isinstance(body.get("last_values"), dict):
            app.state.last_values = body["last_values"]
        if body.get("last_model"):
            app.state.last_model = str(body["last_model"])
        persist()
        return {"ok": True}

    # ---------- schema & command ----------

    @app.get("/api/schema")
    def schema(refresh: bool = False):
        return get_schema(refresh)

    @app.post("/api/preview")
    def preview(body: dict):
        argv = argsmod.build_argv(
            get_schema(), body.get("values") or {}, bool(body.get("resume"))
        )
        return {"argv": argv, "cmd": argsmod.command_string(app.state.python, argv)}

    # ---------- launch & processes ----------

    def _check_path_params(values: dict):
        for name in ("personas", "init_artifacts", "prompt_templates"):
            v = values.get(name)
            if v:
                try:
                    p = store.safe_path(app.state.repo, str(v))
                except ValueError:
                    p = Path(str(v)).expanduser()
                if not p.is_file():
                    raise HTTPException(400, f"{name}: file not found: {v}")

    @app.post("/api/launch")
    def launch(body: dict):
        values = body.get("values") or {}
        if not Path(app.state.python).is_file():
            raise HTTPException(400, f"python not found: {app.state.python}")
        _check_path_params(values)
        argv = argsmod.build_argv(get_schema(), values, bool(body.get("resume")))
        label = str(values.get("exp_name") or "TEST")
        proc = app.state.procs.spawn(
            "sim", label, [app.state.python, *argv], app.state.repo
        )
        app.state.last_values = values
        persist()
        result = {"proc": proc.as_dict(), "viz": None}
        if body.get("launch_viz"):
            result["viz"] = _ensure_viz()
        return result

    def _ensure_viz() -> dict:
        url = f"http://127.0.0.1:{app.state.viz_port}"
        with app.state.viz_lock:
            # a just-spawned viz hasn't bound its port yet — check both
            if _port_open(app.state.viz_port) or app.state.procs.running("viz"):
                return {"url": url, "started": False}
            app.state.procs.spawn(
                "viz",
                f"dashboard:{app.state.viz_port}",
                [app.state.python, "-m", "viz", "--port", str(app.state.viz_port)],
                app.state.repo,
            )
        return {"url": url, "started": True}

    @app.post("/api/viz")
    def start_viz():
        return _ensure_viz()

    @app.get("/api/procs")
    def procs():
        return {
            "procs": app.state.procs.list(),
            "viz_up": _port_open(app.state.viz_port),
        }

    @app.post("/api/procs/{proc_id}/stop")
    def stop_proc(proc_id: int, force: bool = False):
        if not app.state.procs.stop(proc_id, force):
            raise HTTPException(404, "no such running process")
        return {"ok": True}

    @app.get("/api/procs/{proc_id}/log")
    def proc_log(proc_id: int, offset: int = Query(0, ge=0)):
        return app.state.procs.read_log(proc_id, offset)

    # ---------- files (personas / artifacts / configs) ----------

    KIND_NEEDLES = {
        "personas": ["persona"],
        "artifacts": ["artifact"],
        "prompts": ["prompt"],
        "configs": ["config"],
    }

    @app.get("/api/files")
    def files(kind: str):
        needles = KIND_NEEDLES.get(kind)
        if not needles:
            raise HTTPException(400, f"unknown kind {kind}")
        return {"files": store.find_json_files(app.state.repo, needles)}

    @app.get("/api/file")
    def read_file(path: str):
        # .json only, like the write side — anything wider serves .env/.git
        # secrets to whoever can reach the port
        if not path.endswith(".json"):
            raise HTTPException(400, "the launcher only reads .json files")
        try:
            p = store.safe_path(app.state.repo, path)
            return {"path": path, "content": p.read_text()}
        except ValueError as e:
            raise HTTPException(400, str(e))
        except OSError as e:
            raise HTTPException(404, str(e))

    @app.post("/api/file")
    def write_file(body: dict):
        path, content = str(body.get("path", "")), body.get("content", "")
        if not path.endswith(".json"):
            raise HTTPException(400, "the launcher only writes .json files")
        try:
            json.loads(content)
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"not valid JSON: {e}")
        try:
            p = store.safe_path(app.state.repo, path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return {"ok": True, "path": str(p.relative_to(app.state.repo.resolve()))}

    # ---------- saved launch configs ----------

    def _configs_dir() -> Path:
        return app.state.repo / store.CONFIG_DIRNAME

    @app.get("/api/configs")
    def list_configs():
        out = []
        d = _configs_dir()
        if d.is_dir():
            for f in sorted(d.glob("*.json")):
                try:
                    data = json.loads(f.read_text())
                except (OSError, json.JSONDecodeError):
                    continue
                if isinstance(data, dict) and "values" in data:
                    out.append(
                        {
                            "name": data.get("name", f.stem),
                            "path": str(f.relative_to(app.state.repo)),
                            "saved_at": data.get("saved_at"),
                        }
                    )
        return {"configs": out}

    @app.post("/api/configs")
    def save_config(body: dict):
        name = str(body.get("name") or "").strip()
        if not name:
            raise HTTPException(400, "config needs a name")
        slug = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
        payload = {
            "name": name,
            "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "values": body.get("values") or {},
            "launch_viz": bool(body.get("launch_viz")),
            "resume": bool(body.get("resume")),
        }
        d = _configs_dir()
        d.mkdir(parents=True, exist_ok=True)
        path = d / f"{slug}.json"
        path.write_text(json.dumps(payload, indent=2))
        app.state.last_values = payload["values"]
        persist()
        return {"ok": True, "path": str(path.relative_to(app.state.repo))}

    # ---------- prompts & scenario designer ----------

    @app.get("/api/prompts")
    def get_prompts():
        info = prompts.extract_templates(app.state.repo)
        supports = (
            info["supports_override"]
            or "prompt_templates" in param_index(get_schema())
        )
        return {
            **info,
            "supports_override": supports,
            "placeholders": {
                k: sorted(prompts.placeholders(info[k] or ""))
                for k in ("sys_prompt", "agent_prompt")
            },
        }

    @app.get("/api/designer/models")
    def designer_models():
        providers = set()
        for var, provs in KEY_PROVIDERS.items():
            if os.environ.get(var):
                providers.update(provs)
        try:
            # no keys detected -> full catalogue (a typed key can be anything)
            models = designer.suggested_models(providers or None)
        except Exception:
            models = []
        return {
            "models": models,
            "filtered": bool(providers),
            "default": app.state.last_model,
            "keys": {k: bool(os.environ.get(k)) for k in KEY_VARS},
        }

    @app.post("/api/design")
    def run_design(body: dict):
        description = str(body.get("description") or "").strip()
        if not description:
            raise HTTPException(400, "describe the scenario first")
        current = prompts.extract_templates(app.state.repo)
        values = body.get("values") or {}
        schema = get_schema()
        catalog = [
            {
                "name": p["name"],
                "help": p["help"],
                "value": values.get(p["name"], p["default"]),
            }
            for g in schema.get("groups", [])
            for p in g["params"]
            if g["key"] in ("agent", "env")
        ]
        model = str(body.get("model") or designer.DEFAULT_MODEL)
        try:
            result = designer.design(
                description=description,
                model=model,
                api_key=(body.get("api_key") or "").strip() or None,
                sys_prompt=current["sys_prompt"] or "",
                agent_prompt=current["agent_prompt"] or "",
                personas=body.get("personas") or [],
                artifacts=body.get("artifacts") or [],
                param_catalog=catalog,
            )
        except Exception as e:
            raise HTTPException(502, f"designer call failed: {e}")
        app.state.last_model = model
        persist()
        grid_param = param_index(schema).get("grid_size") or {}
        grid = values.get("grid_size") or grid_param.get("default")
        issues = (
            prompts.validate_rewrite(
                current["sys_prompt"], result["sys_prompt"], "system prompt"
            )
            + prompts.validate_rewrite(
                current["agent_prompt"], result["agent_prompt"], "step prompt"
            )
            + prompts.validate_personas(result["personas"])
            + prompts.validate_artifacts(result["init_artifacts"], grid)
        )
        known = param_index(schema)
        for s in result["suggested_params"]:
            if s.get("name") not in known:
                issues.append(
                    f"suggested param '{s.get('name')}' does not exist; ignore it"
                )
        return {"result": result, "issues": issues}

    @app.post("/api/bundle")
    def save_bundle(body: dict):
        name = str(body.get("name") or "scenario").strip() or "scenario"
        slug = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:60]
        d = app.state.repo / store.CONFIG_DIRNAME / "scenarios" / slug
        d.mkdir(parents=True, exist_ok=True)
        rel = d.relative_to(app.state.repo)
        paths = {}
        if body.get("sys_prompt") or body.get("agent_prompt"):
            p = d / "prompt_templates.json"
            p.write_text(
                json.dumps(
                    {
                        "sys_prompt": body.get("sys_prompt") or None,
                        "agent_prompt": body.get("agent_prompt") or None,
                    },
                    indent=2,
                )
            )
            paths["prompt_templates"] = str(rel / "prompt_templates.json")
        if body.get("personas"):
            (d / "personas.json").write_text(json.dumps(body["personas"], indent=2))
            paths["personas"] = str(rel / "personas.json")
        if body.get("init_artifacts"):
            (d / "init_artifacts.json").write_text(
                json.dumps(body["init_artifacts"], indent=2)
            )
            paths["init_artifacts"] = str(rel / "init_artifacts.json")
        return {"ok": True, "dir": str(rel), "paths": paths}

    # ---------- static ----------

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def main():
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo", type=Path, default=None, help="TerraLingua checkout to drive"
    )
    parser.add_argument("--python", default=None, help="Interpreter used to run it")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7000)
    args = parser.parse_args()

    app = create_app(args.repo, args.python)
    print(f"🚀 TerraLingua launcher → http://{args.host}:{args.port}")
    print(f"   driving {app.state.repo} with {app.state.python}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
