"""Files the launcher writes for a run: artifact sets, persona lists and instruction texts.

They live under <workdir>/launcher_content/<kind>/. A run points at them
through a setting (`env.init_artifacts_path`, `agent.personas_path`,
`agent.scenario_specific_instructions`) with a path relative to the working
directory.
"""

import json
import shutil
from pathlib import Path

ROOT = "launcher_content"

#: kind -> (file suffix, whether the setting points at a folder holding one file)
KINDS = {
    "artifacts": (".json", True),
    "personas": (".json", False),
    "instructions": (".md", False),
}


class ContentError(ValueError):
    """A bad kind, name or payload."""


def _check(kind: str, name: str) -> None:
    if kind not in KINDS:
        raise ContentError(f"unknown content kind '{kind}'")
    if not name or name != name.strip() or name.startswith((".", "-")) or "/" in name or "\\" in name:
        raise ContentError("the name must be a plain file name without a path")


def _file(workdir: Path, kind: str, name: str) -> Path:
    suffix, folder = KINDS[kind]
    if folder:
        return workdir / ROOT / kind / name / f"{kind}{suffix}"
    return workdir / ROOT / kind / f"{name}{suffix}"


def setting_path(kind: str, name: str) -> str:
    """The value a run's setting takes: relative to the working directory."""
    suffix, folder = KINDS[kind]
    if folder:
        return f"{ROOT}/{kind}/{name}"
    return f"{ROOT}/{kind}/{name}{suffix}"


def list_items(workdir: Path, kind: str) -> list[dict]:
    if kind not in KINDS:
        raise ContentError(f"unknown content kind '{kind}'")
    suffix, folder = KINDS[kind]
    base = workdir / ROOT / kind
    if not base.is_dir():
        return []
    names = []
    for entry in sorted(base.iterdir()):
        if folder and entry.is_dir() and (entry / f"{kind}{suffix}").is_file():
            names.append(entry.name)
        elif not folder and entry.is_file() and entry.suffix == suffix:
            names.append(entry.stem)
    return [{"name": n, "path": setting_path(kind, n)} for n in names]


def read_item(workdir: Path, kind: str, name: str) -> dict:
    _check(kind, name)
    path = _file(workdir, kind, name)
    if not path.is_file():
        raise FileNotFoundError(f"no {kind} named '{name}'")
    text = path.read_text()
    data = json.loads(text) if path.suffix == ".json" else text
    return {"name": name, "path": setting_path(kind, name), "data": data}


def write_item(workdir: Path, kind: str, name: str, data) -> dict:
    _check(kind, name)
    suffix, _folder = KINDS[kind]
    if suffix == ".json" and not isinstance(data, list):
        raise ContentError(f"{kind} must be a JSON list")
    if suffix == ".md" and not isinstance(data, str):
        raise ContentError(f"{kind} must be text")
    path = _file(workdir, kind, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n" if suffix == ".json" else data)
    return {"name": name, "path": setting_path(kind, name)}


def delete_item(workdir: Path, kind: str, name: str) -> None:
    _check(kind, name)
    path = _file(workdir, kind, name)
    if not path.is_file():
        raise FileNotFoundError(f"no {kind} named '{name}'")
    if KINDS[kind][1]:
        shutil.rmtree(path.parent)
    else:
        path.unlink()
