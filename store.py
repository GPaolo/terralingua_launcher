"""Launcher settings.

The launcher's own state (target, interpreter, last form) lives in the user's
home folder. The working directory only receives what the user saves: presets.
"""

import json
import sys
from pathlib import Path

STATE_PATH = Path.home() / ".terralingua_launcher.json"


def load_state() -> dict:
    try:
        with open(STATE_PATH) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2))


def default_python(workdir: Path) -> str:
    """The working directory's own virtual environment when it has one, else this interpreter."""
    venv = workdir / ".venv" / "bin" / "python"
    return str(venv) if venv.is_file() else sys.executable


def slug(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name.strip())[:60]
