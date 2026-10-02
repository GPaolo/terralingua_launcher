"""Turn a preset and overrides into the `terralingua` command line.

Only the overrides are emitted: the preset carries the rest, and the run's own
params.json is the full record. The syntax is TerraLingua's: the preset first,
`--name value` with the field's short alias, bare `--flag` and `--no-flag` for
booleans, `null` for an optional setting, JSON for lists and dictionaries,
and `--resume`. Changed scenario options travel together as one JSON
dictionary, which TerraLingua merges into the preset's options.
"""

import copy
import json
import shlex

SCENARIO_OPTIONS = "run.scenario_options"
OPTION_PREFIX = SCENARIO_OPTIONS + "."


def _flag_name(path: str, fields: dict) -> str:
    """The shortest alias no other field also answers to, else the full path."""
    aliases = (fields.get(path) or {}).get("aliases") or []
    taken = {
        alias for other, field in fields.items() if other != path for alias in (field.get("aliases") or [])
    }
    return next((alias for alias in aliases if alias not in taken), path)


def _is_boolean(path: str, fields: dict) -> bool:
    """Whether the field takes a boolean, alone or as one choice of an optional field."""
    field = fields.get(path) or {}
    schema = field.get("schema") or {}
    variants = [schema, *schema.get("anyOf", [])]
    return "bool" in str(field.get("type", "")).split(" | ") or any(v.get("type") == "boolean" for v in variants)


def _is_option(path: str) -> bool:
    return path == SCENARIO_OPTIONS or path.startswith(OPTION_PREFIX)


def scenario_options(overrides: dict) -> dict:
    """The changed scenario options as one nested dictionary."""
    overrides = copy.deepcopy(overrides)
    options = overrides.get(SCENARIO_OPTIONS) if isinstance(overrides.get(SCENARIO_OPTIONS), dict) else {}
    for path, value in overrides.items():
        if not path.startswith(OPTION_PREFIX):
            continue
        cursor = options
        *parents, leaf = path[len(OPTION_PREFIX):].split(".")
        for part in parents:
            if not isinstance(cursor.get(part), dict):
                cursor[part] = {}
            cursor = cursor[part]
        cursor[leaf] = value
    return options


def normalized(overrides: dict) -> dict:
    """Overrides with the scenario options folded into one entry, as the command line sends them."""
    rest = {path: value for path, value in overrides.items() if not _is_option(path)}
    options = scenario_options(overrides)
    if options:
        rest[SCENARIO_OPTIONS] = options
    return rest


def build_argv(preset: str | None, overrides: dict, fields: dict, resume: bool = False) -> list[str]:
    argv = [preset] if preset else []
    options = scenario_options(overrides)
    if options:
        argv += ["--scenario_options", json.dumps(options)]
    for path, value in overrides.items():
        if _is_option(path):
            continue
        flag = _flag_name(path, fields)
        if value is None:
            argv += [f"--{flag}", "null"]
        elif isinstance(value, bool) and _is_boolean(path, fields):
            argv.append(f"--{flag}" if value else f"--no-{flag}")
        elif isinstance(value, (list, dict)):
            argv += [f"--{flag}", json.dumps(value)]
        else:
            argv += [f"--{flag}", str(value)]
    if resume:
        argv.append("--resume")
    return argv


def command_string(python: str, argv: list[str]) -> str:
    return shlex.join([python, "-m", "terralingua", *argv])
