"""Launcher settings and remembered form state, in one JSON file."""

import json
import sys
from pathlib import Path

DEFAULT_STATE_PATH = Path.home() / ".terralingua_launcher.json"


class StateFile:
    """The launcher's own state: target, interpreter and last form."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else DEFAULT_STATE_PATH

    def load(self) -> dict:
        try:
            with open(self.path) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def save(self, state: dict) -> None:
        self.path.write_text(json.dumps(state, indent=2))


def default_python(workdir: Path) -> str:
    """The working directory's own virtual environment when it has one, else this interpreter."""
    venv = workdir / ".venv" / "bin" / "python"
    return str(venv) if venv.is_file() else sys.executable


def slug(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name.strip())[:60]
