"""Files a run reads: artifact sets, persona lists and instruction texts.

The launcher's own files live under <workdir>/launcher_content/<kind>/. A
configuration may also name files elsewhere, for example next to its preset.
Three settings name them: `env.init_artifacts_path` (a folder of JSON files),
`agent.personas_path` and `agent.scenario_specific_instructions`. A scenario
option with the same name counts too; a relative value there is read from the
scenario's own folder, as scenarios do.
"""

import json
import os
import shutil
from collections.abc import Iterable
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path

ROOT = "launcher_content"
OPTION_PREFIX = "run.scenario_options."
TEXT_LIMIT = 20000
INSTRUCTION_SUFFIXES = {".md", ".markdown", ".txt", ".jinja", ".j2"}


@dataclass(frozen=True)
class Kind:
    suffix: str
    folder: bool  # the setting names a folder of JSON files
    setting: str  # the core setting that names the file


KINDS = {
    "artifacts": Kind(".json", True, "env.init_artifacts_path"),
    "personas": Kind(".json", False, "agent.personas_path"),
    "instructions": Kind(".md", False, "agent.scenario_specific_instructions"),
}


class ContentError(ValueError):
    """A bad kind, name, path or payload."""


def _kind(kind: str) -> Kind:
    if kind not in KINDS:
        raise ContentError(f"unknown content kind '{kind}'")
    return KINDS[kind]


def _check(kind: str, name: str) -> None:
    _kind(kind)
    if not name or name != name.strip() or name.startswith((".", "-")) or "/" in name or "\\" in name:
        raise ContentError("the name must be a plain file name without a path")


def _check_data(kind: str, data) -> None:
    spec = _kind(kind)
    if spec.suffix == ".json" and not isinstance(data, list):
        raise ContentError(f"{kind} must be a JSON list")
    if spec.suffix == ".md" and not isinstance(data, str):
        raise ContentError(f"{kind} must be text")


def _write(path: Path, spec: Kind, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n" if spec.suffix == ".json" else data)


def _file(workdir: Path, kind: str, name: str) -> Path:
    spec = KINDS[kind]
    if spec.folder:
        return workdir / ROOT / kind / name / f"{kind}{spec.suffix}"
    return workdir / ROOT / kind / f"{name}{spec.suffix}"


def setting_path(kind: str, name: str) -> str:
    """The value a run's setting takes: relative to the working directory."""
    spec = KINDS[kind]
    if spec.folder:
        return f"{ROOT}/{kind}/{name}"
    return f"{ROOT}/{kind}/{name}{spec.suffix}"


# ---------- listing: the launcher's own folder plus any folder the page suggests ----------


def _shape_ok(kind: str, data) -> bool:
    """Whether parsed JSON holds this kind's entries."""
    if kind == "personas":
        return isinstance(data, list) and all(isinstance(e, str) or (isinstance(e, dict) and "persona" in e) for e in data)
    if kind == "artifacts":
        entries = data if isinstance(data, list) else [data]
        return all(isinstance(e, dict) and "art_type" in e for e in entries)
    return True


def _looks_like(kind: str, path: Path) -> bool:
    """Whether a file, or an artifact folder, holds this kind's content."""
    spec = KINDS[kind]
    try:
        if spec.folder:
            files = _json_files(path)
            return bool(files) and all(_shape_ok(kind, json.loads(f.read_text())) for f in files)
        if spec.suffix == ".json":
            return _shape_ok(kind, json.loads(path.read_text()))
        return True
    except (OSError, ValueError):
        return False


def scan_folder(workdir: Path, kind: str, folder: str) -> list[dict]:
    """This kind's files in a folder under the working directory, told apart by their content."""
    spec = _kind(kind)
    base = inside(workdir, folder or ".")
    if not base.is_dir():
        return []
    rel = relative(workdir, base)
    prefix = f"{rel}/" if rel else ""
    items = []
    for entry in sorted(base.iterdir()):
        if entry.name.startswith(".") or entry.name == "__pycache__":
            continue
        if spec.folder:
            if entry.is_dir() and _looks_like(kind, entry):
                items.append((entry.name, entry.name))
        elif entry.is_file() and entry.suffix == spec.suffix and _looks_like(kind, entry):
            items.append((entry.stem, entry.name))
    return [{"name": name, "path": prefix + file, "folder": rel, "deletable": rel == f"{ROOT}/{kind}"} for name, file in items]


def list_items(workdir: Path, kind: str, folders: Iterable[str] = ()) -> list[dict]:
    """The files of a kind in the given folders, then in the launcher's own folder; no folder twice."""
    _kind(kind)
    seen, items = set(), []
    for folder in [*folders, f"{ROOT}/{kind}"]:
        key = relative(workdir, inside(workdir, folder or "."))
        if key in seen:
            continue
        seen.add(key)
        items.extend(scan_folder(workdir, kind, folder))
    return items


# ---------- the launcher's own files, by name ----------


def read_item(workdir: Path, kind: str, name: str) -> dict:
    _check(kind, name)
    if not _file(workdir, kind, name).is_file():
        raise FileNotFoundError(f"no {kind} named '{name}'")
    return {**read_path(workdir, kind, setting_path(kind, name)), "name": name}


def write_item(workdir: Path, kind: str, name: str, data) -> dict:
    _check(kind, name)
    _check_data(kind, data)
    path = _file(workdir, kind, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    _write(path, KINDS[kind], data)
    return {"name": name, "path": setting_path(kind, name)}


def delete_item(workdir: Path, kind: str, name: str) -> None:
    _check(kind, name)
    path = _file(workdir, kind, name)
    if not path.is_file():
        raise FileNotFoundError(f"no {kind} named '{name}'")
    if KINDS[kind].folder:
        shutil.rmtree(path.parent)
    else:
        path.unlink()


# ---------- any file under the working directory, by path ----------


def inside(workdir: Path, value: str | Path) -> Path:
    """The absolute path of a file under the working directory; anything else is refused."""
    path = Path(value)
    if not path.is_absolute():
        path = workdir / path
    resolved = path.resolve()
    if relative(workdir, resolved) is None:
        raise ContentError(f"{value} is outside the working directory")
    return resolved


def relative(workdir: Path, path: Path) -> str | None:
    """`path` relative to the working directory, or None when it lies outside."""
    try:
        text = str(path.resolve().relative_to(workdir.resolve()))
    except ValueError:
        return None
    return "" if text == "." else text


def _json_files(folder: Path) -> list[Path]:
    return sorted(p for p in folder.glob("*.json") if p.is_file())


def read_path(workdir: Path, kind: str, value: str) -> dict:
    """A file (or an artifact folder) by its path; `writable` says whether a save can go back to it."""
    spec = _kind(kind)
    path = inside(workdir, value)
    rel = relative(workdir, path)
    if spec.folder:
        if not path.is_dir():
            raise FileNotFoundError(f"no folder {value}")
        files = _json_files(path)
        data = []
        for file in files:
            loaded = json.loads(file.read_text())
            data.extend(loaded if isinstance(loaded, list) else [loaded])
        return {"name": path.name, "path": rel, "data": data, "files": [f.name for f in files], "writable": len(files) <= 1}
    if not path.is_file():
        raise FileNotFoundError(f"no file {value}")
    text = path.read_text()
    data = json.loads(text) if spec.suffix == ".json" else text
    return {"name": path.stem, "path": rel, "data": data, "writable": True}


def write_path(workdir: Path, kind: str, value: str, data) -> dict:
    """Write a file in place. An artifact folder keeps its one JSON file, or gets artifacts.json."""
    spec = _kind(kind)
    _check_data(kind, data)
    path = inside(workdir, value)
    if spec.folder:
        if path.exists() and not path.is_dir():
            raise ContentError(f"{value} is not a folder")
        files = _json_files(path) if path.is_dir() else []
        if len(files) > 1:
            raise ContentError(f"{value} holds {len(files)} JSON files; save the set under a new name instead")
        path.mkdir(parents=True, exist_ok=True)
        target = inside(workdir, files[0]) if files else path / f"{kind}{spec.suffix}"
    else:
        if path.is_dir():
            raise ContentError(f"{value} is a folder")
        if spec.suffix == ".json" and path.suffix != ".json":
            raise ContentError(f"{value} must be a JSON file")
        if kind == "instructions" and path.suffix.lower() not in INSTRUCTION_SUFFIXES:
            raise ContentError(f"{value} must be a text file: {', '.join(sorted(INSTRUCTION_SUFFIXES))}")
        path.parent.mkdir(parents=True, exist_ok=True)
        target = path
    _write(target, spec, data)
    return {"name": path.name if spec.folder else path.stem, "path": relative(workdir, path)}


# ---------- extra files: any JSON the user registers, whatever it holds ----------


def check_json_path(workdir: Path, value: str) -> str:
    """A registrable path, relative to the working directory."""
    path = inside(workdir, value)
    if path.suffix != ".json":
        raise ContentError(f"{value} is not a JSON file")
    if path.is_dir():
        raise ContentError(f"{value} is a folder")
    return relative(workdir, path)


def read_json(workdir: Path, value: str) -> dict:
    """A JSON file under the working directory, whatever shape it holds."""
    rel = check_json_path(workdir, value)
    path = workdir / rel
    if not path.is_file():
        raise FileNotFoundError(f"no file {value}")
    return {"name": path.stem, "path": rel, "data": json.loads(path.read_text()), "writable": True}


def write_json(workdir: Path, value: str, data) -> dict:
    """Write any JSON value to a file under the working directory, creating it if need be."""
    rel = check_json_path(workdir, value)
    path = workdir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return {"name": path.stem, "path": rel}


def referencing(workdir: Path, values: dict, scenario_dir: Path | None, value: str) -> list[str]:
    """The settings of a configuration whose value points at this file."""
    path = inside(workdir, value)
    return sorted(
        setting
        for setting, text in values.items()
        if isinstance(text, str) and text.strip()
        and resolve(workdir, setting, text, scenario_dir).resolve() == path
    )


# ---------- the files a configuration names ----------


def settings_for(kind: str, fields: dict) -> list[str]:
    """The settings that can name this kind's file: the scenario's own options first, then the core one."""
    core = _kind(kind).setting
    leaf = core.rsplit(".", 1)[1]
    options = sorted(p for p in fields if p.startswith(OPTION_PREFIX) and p.rsplit(".", 1)[1] == leaf)
    return [*options, core]


def is_builtin_name(workdir: Path, kind: str, value: str) -> bool:
    """An instructions value that names one of TerraLingua's built-in texts rather than a file:
    no separator or dot, and no such file in the working directory."""
    return kind == "instructions" and not any(c in value for c in "/\\.") and not (workdir / value).exists()


def resolve(workdir: Path, setting: str, value: str, scenario_dir: Path | None) -> Path:
    """Where a value points: a relative core setting from the working directory, as the command line
    reads it (a preset's values arrive absolute); a relative scenario option from the scenario's folder."""
    path = Path(value)
    if path.is_absolute():
        return path
    if setting.startswith(OPTION_PREFIX) and scenario_dir is not None:
        return scenario_dir / path
    return workdir / path


def source(workdir: Path, kind: str, fields: dict, values: dict, scenario_dir: Path | None) -> dict:
    """The file this kind's setting names in a configuration, resolved and checked.

    `base` is the folder a relative value of the setting is read from, relative to the
    working directory: "" for the working directory itself, None when it is not under it.
    """
    spec = _kind(kind)
    candidates = settings_for(kind, fields)
    named = [s for s in candidates if isinstance(values.get(s), str) and values[s].strip()]
    setting = named[0] if named else candidates[-1]
    base = ""
    if setting.startswith(OPTION_PREFIX):
        base = relative(workdir, scenario_dir) if scenario_dir is not None else None
    out = {
        "setting": setting, "value": values.get(setting) if named else None, "builtin": None,
        "path": None, "relative": None, "exists": False, "inside": False, "base": base,
    }
    if not named:
        return out
    if is_builtin_name(workdir, kind, out["value"]):
        out["builtin"] = out["value"]
        return out
    path = resolve(workdir, setting, out["value"], scenario_dir)
    rel = relative(workdir, path)
    out.update(path=str(path), relative=rel, inside=rel is not None)
    if spec.folder:
        out["exists"] = path.is_dir()
        if out["exists"]:
            out["files"] = [f.name for f in _json_files(path)]
    else:
        out["exists"] = path.is_file()
        if out["exists"] and kind == "instructions":
            text = path.read_text(errors="replace")
            out["text"] = text[:TEXT_LIMIT]
            out["truncated"] = len(text) > TEXT_LIMIT
    return out


def sources(workdir: Path, fields: dict, values: dict, scenario_dir: Path | None) -> dict:
    return {kind: source(workdir, kind, fields, values, scenario_dir) for kind in KINDS}


def _get(config: dict, keys):
    cursor = config
    for key in keys:
        if not isinstance(cursor, dict) or key not in cursor:
            return None
        cursor = cursor[key]
    return cursor


def _set(config: dict, keys, value) -> None:
    cursor = config
    for key in keys[:-1]:
        cursor = cursor[key]
    cursor[keys[-1]] = value


def _leaves(config: dict, prefix: tuple = ()):
    for key, value in config.items():
        if isinstance(value, dict):
            yield from _leaves(value, (*prefix, key))
        else:
            yield (*prefix, key), value


def _written(path: Path, workdir: Path, preset_dir: Path) -> str:
    """A path as a preset file in `preset_dir` names it: relative when under the working directory."""
    if relative(workdir, path) is None:
        return str(path)
    return os.path.relpath(path.resolve(), preset_dir.resolve())


def rebase_paths(config: dict, workdir: Path, preset_dir: Path, raw: dict | None = None, raw_dir: Path | None = None) -> dict:
    """The composed configuration with its paths written relative to the preset file's folder, as
    TerraLingua reads them from a preset.

    A relative path of the source preset (`raw`, the file in `raw_dir`) that TerraLingua made absolute
    goes back to relative, whatever the setting. The content settings, which an override sets relative
    to the working directory, follow. Paths outside the working directory stay absolute, and scenario
    options are left as they are: the scenario reads them, not the preset.
    """
    out = deepcopy(config)
    done = set()
    for keys, value in _leaves(raw or {}) if raw_dir is not None else ():
        current = _get(out, keys)
        resolved = isinstance(value, str) and value and not Path(value).is_absolute()
        if resolved and isinstance(current, str) and Path(current).is_absolute() and Path(current).resolve() == (raw_dir / value).resolve():
            _set(out, keys, _written(Path(current), workdir, preset_dir))
            done.add(keys)
    for kind, spec in KINDS.items():
        keys = tuple(spec.setting.split("."))
        value = _get(out, keys)
        if keys in done or not isinstance(value, str) or not value.strip() or is_builtin_name(workdir, kind, value):
            continue
        _set(out, keys, _written(resolve(workdir, spec.setting, value, None), workdir, preset_dir))
    return out
