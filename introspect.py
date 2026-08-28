"""Dumps a TerraLingua repo's launch-parameter schema as JSON on stdout.

Run with the *target repo's* python interpreter and cwd so `core` imports
resolve there:

    cd <tl_repo> && python <this file>

The launcher shells out to this script instead of importing TL code, so it
keeps working against any TL version that keeps the dataclass-config pattern
(core/experiment/config.py with `help`/`choices` field metadata). Params added
or removed upstream simply appear or vanish from the UI.
"""

import contextlib
import json
import os
import sys
from dataclasses import MISSING, fields

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")


def _json_safe(value):
    if isinstance(value, tuple):
        return list(value)
    if value is None or isinstance(value, (bool, int, float, str, list)):
        return value
    return str(value)


def _type_name(f):
    t = f.type
    if t is bool or t == "bool":
        return "bool"
    if t is int or t == "int":
        return "int"
    if t is float or t == "float":
        return "float"
    if t is str or t == "str":
        return "str"
    name = getattr(t, "__name__", None) or str(t)
    if "| None" in name or "Optional" in name:
        base = name.replace("| None", "").replace("None |", "").strip()
        if base in ("int", "float", "str", "bool"):
            return base
    return "str"


def _param(f):
    meta = dict(f.metadata or {})
    default = f.default if f.default is not MISSING else None
    if f.default_factory is not MISSING:  # type: ignore[misc]
        default = f.default_factory()  # type: ignore[misc]
    entry = {
        "name": f.name,
        "type": _type_name(f),
        "default": _json_safe(default),
        "help": meta.get("help", ""),
        "choices": _json_safe(meta.get("choices")),
        "nargs": bool(meta.get("nargs")) or isinstance(default, (tuple, list)),
        "autocoerce": meta.get("autocoerce"),
        "optional": "None" in str(f.type) or default is None,
    }
    return entry


def _collect():
    result = {"groups": [], "extras": {}, "errors": []}
    try:
        from core.experiment.config import AgentConfig, EnvConfig, RunConfig

        for key, title, cls in (
            ("agent", "Agent", AgentConfig),
            ("env", "Environment", EnvConfig),
            ("run", "Run", RunConfig),
        ):
            params = [
                _param(f)
                for f in fields(cls)
                if not (f.metadata or {}).get("excluded", False)
            ]
            result["groups"].append({"key": key, "title": title, "params": params})
    except Exception as e:  # the launcher shows this instead of a form
        result["errors"].append(f"config introspection failed: {e!r}")

    try:
        from core.experiment.llm_router import MODEL_MAP

        result["extras"]["model_suggestions"] = list(MODEL_MAP.keys())
    except Exception as e:
        result["errors"].append(f"model map unavailable: {e!r}")

    return result


def main():
    # Imports chatter on stdout (pygame's banner, dotenv notices); only the
    # JSON may reach the pipe the launcher parses.
    with contextlib.redirect_stdout(sys.stderr):
        result = _collect()
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
