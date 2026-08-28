"""Translates form values into a `python main.py ...` argument vector.

Only values that differ from the introspected defaults are emitted, so the
command stays readable and the run's own params.json remains the full record.
"""

import shlex


def _differs(value, default) -> bool:
    if value is None or value == "":
        return False
    if isinstance(value, bool) or isinstance(default, bool):
        return bool(value) != bool(default)
    # 50 == 50.0 keeps int/float form round-trips from emitting no-op flags.
    return value != default


def _tokens(param: dict, value) -> list[str]:
    flag = f"--{param['name']}"
    if param["type"] == "bool":
        return [flag if value else f"--no-{param['name']}"]
    if param.get("autocoerce") or param.get("nargs"):
        # food_zones: 4 | "10,10 12,5" | [[10,10],[12,5]]; ports: [9000, ...]
        if isinstance(value, (int, float)):
            return [flag, str(value)]
        if isinstance(value, str):
            return [flag, *value.split()]
        parts = [
            ",".join(str(int(c)) for c in v) if isinstance(v, (list, tuple)) else str(v)
            for v in value
        ]
        return [flag, *parts]
    return [flag, str(value)]


def build_argv(schema: dict, values: dict, resume: bool = False) -> list[str]:
    argv = ["main.py"]
    for group in schema.get("groups", []):
        for param in group["params"]:
            name = param["name"]
            if name not in values:
                continue
            if _differs(values[name], param["default"]):
                argv.extend(_tokens(param, values[name]))
    if resume:
        argv.append("--resume")
    return argv


def command_string(python: str, argv: list[str]) -> str:
    return " ".join(shlex.quote(t) for t in [python, *argv])
