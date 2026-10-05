"""Run TerraLingua's own configuration commands in the target interpreter.

The launcher never imports TerraLingua. It runs `python -m terralingua.config`
in the interpreter that will run the simulations, with the working directory
that holds the presets, and reads the JSON those commands print. Settings
added to TerraLingua appear in the launcher by themselves.
"""

import importlib.metadata
import json
import os
import subprocess
from pathlib import Path

TIMEOUT = 180


class TargetError(Exception):
    """The target interpreter could not answer."""


class TargetRejected(TargetError):
    """The target answered with an error report about the request."""


def _run(python: str, workdir: Path, args: list[str], env: dict | None = None) -> str:
    run_env = {**(os.environ if env is None else env), "PYGAME_HIDE_SUPPORT_PROMPT": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    try:
        out = subprocess.run(
            [python, *args], cwd=str(workdir), capture_output=True, text=True,
            timeout=TIMEOUT, env=run_env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise TargetError(f"could not run {python}: {exc}") from exc
    if out.returncode not in (0, 2):  # 2 is a JSON error report from the config commands
        raise TargetError(out.stderr.strip()[-2000:] or f"exit {out.returncode}")
    return out.stdout


def _json(text: str) -> dict:
    """The JSON object in a command's output, skipping any banner before it."""
    start = text.find("{")
    if start < 0:
        raise TargetError("the command printed no JSON")
    try:
        return json.loads(text[start:])
    except json.JSONDecodeError as exc:
        raise TargetError(f"the command printed invalid JSON: {exc}") from exc


def _accepted(result: dict) -> dict:
    """The result, unless the command answered with an error report."""
    if result.get("valid") is False:
        messages = "; ".join(d.get("message", "") for d in result.get("diagnostics", []))
        raise TargetRejected(messages or "the command rejected the request")
    return result


def describe(python: str, workdir: Path, preset: str | None = None, env: dict | None = None) -> dict:
    """Fields, groups and dependencies; with a preset, its scenario's options too."""
    args = ["-m", "terralingua.config", "describe"]
    if preset:
        args += ["--preset", preset]
    return _accepted(_json(_run(python, workdir, args, env)))


def evaluate(python: str, workdir: Path, preset: str | None, overrides: dict, env: dict | None = None) -> dict:
    """Validate a preset plus overrides: field states, values and diagnostics.

    An invalid configuration is a normal answer here, with its diagnostics.
    """
    args = ["-m", "terralingua.config", "evaluate", "--overrides", json.dumps(overrides)]
    if preset:
        args += ["--preset", preset]
    return _json(_run(python, workdir, args, env))


def presets(python: str, workdir: Path, env: dict | None = None) -> list[dict]:
    """The presets the target finds: built-ins plus those under the working directory."""
    return _accepted(_json(_run(python, workdir, ["-m", "terralingua.config", "presets"], env)))["presets"]


def artifact_types(python: str, workdir: Path, preset: str | None = None, env: dict | None = None) -> list[dict]:
    """The artifact types a run can seed, with the parameters each one adds."""
    args = ["-m", "terralingua.config", "artifact-types"]
    if preset:
        args += ["--preset", preset]
    return _accepted(_json(_run(python, workdir, args, env)))["artifact_types"]


def version(python: str, workdir: Path, env: dict | None = None) -> str | None:
    """The installed terralingua version, or None when it is not installed."""
    try:
        return _accepted(_json(_run(python, workdir, ["-m", "terralingua.config", "version"], env)))["version"]
    except TargetError:
        return None


def module_dir(python: str, workdir: Path, module: str, env: dict | None = None) -> str | None:
    """The folder of a package the target interpreter imports, or None.

    Not a TerraLingua command: a scenario reads its own files from its folder,
    and only the target interpreter knows where the package is.
    """
    code = (
        "import importlib.util, json, pathlib, sys\n"
        "spec = importlib.util.find_spec(sys.argv[1])\n"
        "where = None\n"
        "if spec is not None:\n"
        "    places = list(spec.submodule_search_locations or [])\n"
        "    where = places[0] if places else (str(pathlib.Path(spec.origin).parent) if spec.origin else None)\n"
        "print(json.dumps({'dir': where}))\n"
    )
    try:
        return _json(_run(python, workdir, ["-c", code, module], env)).get("dir")
    except TargetError:
        return None


def launcher_version() -> str:
    try:
        return importlib.metadata.version("terralingua-launcher")
    except importlib.metadata.PackageNotFoundError:
        return "dev"
