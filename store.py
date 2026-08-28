"""Launcher settings and path safety.

The launcher's own state (target repo, python, last form values) lives in the
user's home dir, never in the target repo: the repo only receives artifacts the
user explicitly saves (configs, personas, scenario bundles).
"""

import json
import sys
from pathlib import Path

STATE_PATH = Path.home() / ".terralingua_launcher.json"

#: Where saved configs / persona files / scenario bundles go, under the repo.
CONFIG_DIRNAME = "launcher_configs"

_SKIP_DIRS = {
    ".git",
    ".venv",
    "logs",
    "node_modules",
    "__pycache__",
    "open_gridworld.egg-info",
    "frames",
}


def looks_like_tl_repo(path: Path) -> bool:
    return (path / "main.py").is_file() and (
        path / "core" / "experiment" / "config.py"
    ).is_file()


def detect_repo() -> Path | None:
    """cwd first (launcher run from inside a TL checkout), then the directory
    this package sits in (launcher vendored into a TL checkout)."""
    for candidate in (Path.cwd(), Path(__file__).resolve().parent.parent):
        if looks_like_tl_repo(candidate):
            return candidate
    return None


def default_python(repo: Path | None) -> str:
    if repo is not None:
        venv = repo / ".venv" / "bin" / "python"
        if venv.is_file():
            return str(venv)
    return sys.executable


def load_state() -> dict:
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2))


def safe_path(repo: Path, path: str) -> Path:
    """Resolves a repo-relative or absolute path, refusing escapes from repo."""
    p = Path(path)
    if not p.is_absolute():
        p = repo / p
    p = p.resolve()
    if not p.is_relative_to(repo.resolve()):
        raise ValueError(f"path {path!r} is outside the target repo")
    return p


def find_json_files(repo: Path, needles: list[str], limit: int = 200) -> list[str]:
    """Repo-relative paths of .json files whose name contains any needle."""
    hits: list[str] = []
    root = repo.resolve()

    def walk(d: Path, depth: int):
        if depth > 6 or len(hits) >= limit:
            return
        try:
            entries = sorted(d.iterdir())
        except OSError:
            return
        for e in entries:
            if len(hits) >= limit:
                return
            if e.is_dir():
                if e.name not in _SKIP_DIRS and not e.name.startswith("."):
                    walk(e, depth + 1)
            elif e.suffix == ".json" and any(n in e.name.lower() for n in needles):
                hits.append(str(e.relative_to(root)))

    walk(root, 0)
    return hits
