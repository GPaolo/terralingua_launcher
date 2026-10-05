"""Preset files: the composed configuration written back as YAML, and the raw config read in."""

from pathlib import Path

import yaml


class _Dumper(yaml.SafeDumper):
    """Lists of plain values, such as a pose, stay on one line."""


def _represent_list(dumper: yaml.SafeDumper, data: list):
    flow = all(not isinstance(item, (dict, list)) for item in data)
    return dumper.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=flow)


_Dumper.add_representer(list, _represent_list)


def text(name: str, description: str, config: dict) -> str:
    data = {"name": name, "description": description, "config": config}
    return yaml.dump(data, Dumper=_Dumper, sort_keys=False, allow_unicode=True)


def read_config(path: Path) -> dict:
    """The `config` block of a preset file as written, with its paths still relative."""
    data = yaml.safe_load(Path(path).read_text())
    config = data.get("config") if isinstance(data, dict) else None
    return config if isinstance(config, dict) else {}
