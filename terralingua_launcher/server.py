"""FastAPI app for the TerraLingua launcher.

The launcher drives a working directory (where presets live and runs write
their logs) with a Python interpreter that has terralingua installed. It reads
fields, dependencies and field states from TerraLingua's own configuration
commands, builds the `terralingua` command line, starts runs as child
processes and shows their logs.
"""

import argparse
import os
import shutil
import socket
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn
import yaml
from dotenv import dotenv_values
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from terralingua_launcher import command, content, designer, store, target
from terralingua_launcher.procs import ProcRegistry

STATIC_DIR = Path(__file__).parent / "static"

#: key variables TerraLingua's model routing reads; shown as chips in the header
KEY_VARS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_BEARER_TOKEN_BEDROCK")


def environment(workdir: Path) -> dict:
    """The environment a run sees: the launcher's own plus the working directory's .env."""
    loaded = {k: v for k, v in (dotenv_values(workdir / ".env") or {}).items() if v}
    return {**os.environ, **loaded}


def resolve_python(python: str) -> str | None:
    """The absolute path of an executable interpreter, or None. Symlinks stay as they are."""
    found = shutil.which(str(Path(python).expanduser()))
    return os.path.abspath(found) if found else None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def create_app(
    workdir: Path | None = None, python: str | None = None, state_path: Path | None = None,
    complete=designer.litellm_complete,
) -> FastAPI:
    """The app. `complete(model, messages, api_key) -> str` asks the designer's model."""
    app = FastAPI(title="TerraLingua Launcher")
    app.state.file = store.StateFile(state_path)
    state = app.state.file.load()
    app.state.workdir = Path(workdir or state.get("workdir") or Path.cwd()).expanduser().resolve()
    requested = str(python or state.get("python") or store.default_python(app.state.workdir))
    app.state.python = resolve_python(requested) or requested
    app.state.env = environment(app.state.workdir)
    app.state.last = state.get("last") or {}
    app.state.schema_cache = {}  # (python, workdir, preset) -> description
    app.state.procs = ProcRegistry()

    @app.middleware("http")
    async def same_origin_only(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host", ""):
            return JSONResponse({"detail": "cross-origin requests are not allowed"}, status_code=403)
        return await call_next(request)

    def persist():
        app.state.file.save({
            "workdir": str(app.state.workdir),
            "python": app.state.python,
            "last": app.state.last,
        })

    def python_ok() -> bool:
        return Path(app.state.python).is_file() and os.access(app.state.python, os.X_OK)

    def ask(call, *args):
        """Run a target command; a rejected request is the client's fault, a failed one the target's."""
        try:
            return call(app.state.python, app.state.workdir, *args, env=app.state.env)
        except target.TargetRejected as exc:
            raise HTTPException(400, str(exc)) from exc
        except target.TargetError as exc:
            raise HTTPException(500, str(exc)) from exc

    def schema(preset: str | None, refresh: bool = False) -> dict:
        key = (app.state.python, str(app.state.workdir), preset or "")
        if refresh or key not in app.state.schema_cache:
            app.state.schema_cache[key] = ask(target.describe, preset)
        return app.state.schema_cache[key]

    def all_fields(description: dict) -> dict:
        fields = dict(description.get("fields", {}))
        fields.update((description.get("scenario") or {}).get("fields", {}))
        return fields

    def overrides_of(body: dict) -> dict:
        overrides = body.get("overrides")
        if overrides is None:
            return {}
        if not isinstance(overrides, dict):
            raise HTTPException(400, "overrides must be a JSON object keyed by field path")
        return overrides

    # ---------- settings ----------

    @app.get("/api/settings")
    def get_settings():
        ok = python_ok()
        return {
            "workdir": str(app.state.workdir),
            "python": app.state.python,
            "workdir_ok": app.state.workdir.is_dir(),
            "python_ok": ok,
            "terralingua_version": target.version(app.state.python, app.state.workdir, env=app.state.env) if ok else None,
            "launcher_version": target.launcher_version(),
            "keys": {k: bool(app.state.env.get(k)) for k in KEY_VARS},
            "last": app.state.last,
        }

    @app.post("/api/settings")
    def set_settings(body: dict):
        workdir, python = app.state.workdir, app.state.python
        if body.get("workdir"):
            workdir = Path(str(body["workdir"])).expanduser().resolve()
            if not workdir.is_dir():
                raise HTTPException(400, f"{workdir} is not a folder")
        if body.get("python"):
            python = resolve_python(str(body["python"]))
            if python is None:
                raise HTTPException(400, f"{body['python']} is not an executable file")
        env = environment(workdir)
        if target.version(python, workdir, env=env) is None:
            raise HTTPException(400, f"{python} has no terralingua installed")
        app.state.workdir, app.state.python, app.state.env = workdir, python, env
        app.state.schema_cache = {}
        persist()
        return get_settings()

    @app.get("/api/fs")
    def fs_complete(prefix: str = "", dirs_only: bool = False):
        """Path completion for the settings fields: folder and executable names only."""
        raw = prefix or "~/"
        p = Path(raw).expanduser()
        base, partial = (p, "") if raw.endswith("/") else (p.parent, p.name)
        out = []
        try:
            for entry in sorted(base.iterdir()):
                name = entry.name
                if partial and not name.lower().startswith(partial.lower()):
                    continue
                if name.startswith(".") and not partial.startswith("."):
                    continue
                if entry.is_dir():
                    out.append(str(entry) + "/")
                elif not dirs_only and os.access(entry, os.X_OK):
                    out.append(str(entry))
                if len(out) >= 50:
                    break
        except OSError:
            pass
        return {"paths": out}

    @app.post("/api/state")
    def set_state(body: dict):
        """Remember the form: preset, overrides and the resume switch."""
        app.state.last = {
            "preset": body.get("preset") or None,
            "overrides": overrides_of(body),
            "resume": bool(body.get("resume")),
        }
        persist()
        return {"ok": True}

    # ---------- presets, schema, evaluation ----------

    @app.get("/api/presets")
    def list_presets():
        return {"presets": ask(target.presets)}

    @app.get("/api/schema")
    def get_schema(preset: str | None = None, refresh: bool = False):
        return schema(preset, refresh)

    @app.post("/api/evaluate")
    def evaluate(body: dict):
        return ask(target.evaluate, body.get("preset") or None, command.normalized(overrides_of(body)))

    @app.post("/api/preview")
    def preview(body: dict):
        preset = body.get("preset") or None
        argv = command.build_argv(preset, overrides_of(body), all_fields(schema(preset)), bool(body.get("resume")))
        return {"argv": argv, "cmd": command.command_string(app.state.python, argv)}

    @app.post("/api/presets")
    def save_preset(body: dict):
        """Write the composed configuration as a new preset file in the working directory."""
        name = str(body.get("name") or "").strip()
        if not name or name.startswith("-") or not store.slug(name).strip("_"):
            raise HTTPException(400, "the preset needs a name made of letters, digits, spaces, '-' or '_'")
        if any(p["name"] == name for p in ask(target.presets)):
            raise HTTPException(400, f"a preset named '{name}' exists already")
        result = ask(target.evaluate, body.get("preset") or None, command.normalized(overrides_of(body)))
        if not result.get("valid", False):
            messages = "; ".join(d["message"] for d in result.get("diagnostics", []))
            raise HTTPException(400, f"the configuration is not valid: {messages}")
        path = app.state.workdir / f"{store.slug(name)}.preset.yaml"
        if path.exists():
            raise HTTPException(400, f"{path.name} exists already")
        data = {"name": name, "description": str(body.get("description") or ""), "config": result["requested"]}
        path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
        app.state.schema_cache = {}
        return {"ok": True, "path": str(path)}

    # ---------- content files: artifact sets, persona lists, instruction texts ----------

    def content_call(call, *args):
        try:
            return call(app.state.workdir, *args)
        except content.ContentError as exc:
            raise HTTPException(400, str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(400, f"could not read the file: {exc}") from exc

    @app.get("/api/content/{kind}")
    def list_content(kind: str):
        return {"items": content_call(content.list_items, kind)}

    @app.get("/api/content/{kind}/{name}")
    def read_content(kind: str, name: str):
        return content_call(content.read_item, kind, name)

    @app.put("/api/content/{kind}/{name}")
    def write_content(kind: str, name: str, body: dict):
        if "data" not in body:
            raise HTTPException(400, "the body needs a 'data' field")
        return content_call(content.write_item, kind, name, body["data"])

    @app.delete("/api/content/{kind}/{name}")
    def delete_content(kind: str, name: str):
        content_call(content.delete_item, kind, name)
        return {"ok": True}

    @app.get("/api/artifact_types")
    def get_artifact_types(preset: str | None = None):
        return {"types": ask(target.artifact_types, preset or None)}

    # ---------- the scenario designer ----------

    def file_text(value) -> str:
        """The content of a text file named by a setting, or an empty string."""
        if not isinstance(value, str) or not value:
            return ""
        path = Path(value) if Path(value).is_absolute() else app.state.workdir / value
        try:
            return path.read_text() if path.is_file() else ""
        except OSError:
            return ""

    @app.post("/api/design")
    def run_design(body: dict):
        description = str(body.get("description") or "").strip()
        if not description:
            raise HTTPException(400, "describe the scenario first")
        preset = body.get("preset") or None
        overrides = overrides_of(body)
        description_of_target = schema(preset)
        fields = all_fields(description_of_target)
        evaluated = ask(target.evaluate, preset, command.normalized(overrides))
        if not evaluated.get("valid"):
            raise HTTPException(400, "fix the configuration before designing: " + "; ".join(
                d["message"] for d in evaluated.get("diagnostics", []) if d["severity"] == "error"
            ))
        values = {**evaluated.get("inactive_values", {}), **evaluated.get("active_values", {})}
        instructions = values.get("agent.scenario_specific_instructions")
        context = {
            "world_type": values.get("env.world_type"),
            "init_agents": values.get("env.init_agents"),
            "fields": fields,
            "values": values,
            "artifact_types": ask(target.artifact_types, preset),
            "instructions_source": instructions if isinstance(instructions, str) else "none",
            "instructions_text": file_text(instructions),
        }
        model = str(body.get("model") or designer.DEFAULT_MODEL)
        api_key = str(body.get("api_key") or "") or designer.key_for(model, app.state.env)
        try:
            return designer.design(
                description, context, model, api_key, complete,
                previous=body.get("previous") if isinstance(body.get("previous"), dict) else None,
                feedback=str(body.get("feedback") or ""),
            )
        except ValueError as exc:
            raise HTTPException(502, str(exc)) from exc
        except Exception as exc:  # the model provider failed; its message is the useful part
            raise HTTPException(502, f"the model call failed: {exc}") from exc

    # ---------- launch & processes ----------

    @app.post("/api/launch")
    def launch(body: dict):
        if not python_ok():
            raise HTTPException(400, f"{app.state.python} is not an executable interpreter")
        preset = body.get("preset") or None
        overrides = overrides_of(body)
        argv = command.build_argv(preset, overrides, all_fields(schema(preset)), bool(body.get("resume")))
        label = str(overrides.get("run.exp_name") or preset or "run")
        try:
            proc = app.state.procs.spawn(
                label, [app.state.python, "-m", "terralingua", *argv], app.state.workdir, app.state.env
            )
        except OSError as exc:
            raise HTTPException(400, f"could not start {app.state.python}: {exc}") from exc
        app.state.last = {"preset": preset, "overrides": overrides, "resume": bool(body.get("resume"))}
        persist()
        return {"proc": proc.as_dict()}

    @app.post("/api/tools/{name}")
    def start_tool(name: str, body: dict):
        """Start a tool the preset's scenario ships (viewer, anthropologist) on a free port."""
        if not python_ok():
            raise HTTPException(400, f"{app.state.python} is not an executable interpreter")
        preset = body.get("preset") or None
        tools = (schema(preset).get("scenario") or {}).get("tools") or {}
        module = tools.get(name)
        if not module:
            raise HTTPException(400, f"the preset has no {name}")
        logs = app.state.env.get("TL_LOGS_DIR") or str(app.state.workdir / "logs")
        port = free_port()
        url = f"http://127.0.0.1:{port}"
        argv = [app.state.python, "-m", module, "--logs", logs, "--port", str(port)]
        try:
            proc = app.state.procs.spawn(f"{name} for {preset}", argv, app.state.workdir, app.state.env, url)
        except OSError as exc:
            raise HTTPException(400, f"could not start {app.state.python}: {exc}") from exc
        return {"proc": proc.as_dict(), "url": url}

    @app.get("/api/procs")
    def procs():
        return {"procs": app.state.procs.list()}

    @app.post("/api/procs/{proc_id}/stop")
    def stop_proc(proc_id: int, force: bool = False):
        if not app.state.procs.stop(proc_id, force):
            raise HTTPException(404, "no such running process")
        return {"ok": True}

    @app.get("/api/procs/{proc_id}/log")
    def proc_log(proc_id: int, offset: int = Query(0, ge=0)):
        if app.state.procs.get(proc_id) is None:
            raise HTTPException(404, "no such process")
        return app.state.procs.read_log(proc_id, offset)

    # ---------- static ----------

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", type=Path, default=None, help="Folder with the presets; runs write logs/ under it")
    parser.add_argument("--python", default=None, help="Interpreter with terralingua installed, used to run the simulations")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7000)
    args = parser.parse_args()

    app = create_app(args.workdir, args.python)
    print(f"TerraLingua launcher: http://{args.host}:{args.port}")
    print(f"working directory {app.state.workdir}, interpreter {app.state.python}")
    if target.version(app.state.python, app.state.workdir, env=app.state.env) is None:
        print("warning: this interpreter has no terralingua installed; set another one in the Settings panel")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
