"""Reads the target repo's agent prompt templates and validates rewrites.

Extraction is `ast`-based on core/agents/prompt_templates.py — no target
import, so it works whatever deps the target env has. A rewrite is valid when
it still parses as jinja and keeps every placeholder the original used (the
runner fills exactly those; a dropped one loses information, a renamed one
crashes the render).
"""

import ast
import re
from pathlib import Path

TEMPLATE_FILE = Path("core") / "agents" / "prompt_templates.py"
TEMPLATE_NAMES = {"SYS_PROMPT": "sys_prompt", "AGENT_PROMPT": "agent_prompt"}

_VAR_RE = re.compile(r"{{-?\s*([a-zA-Z_]\w*)")
_TAG_RE = re.compile(r"{%-?\s*(?:if|elif|for)\s+(.+?)\s*-?%}")
_IDENT_RE = re.compile(r"\b([a-zA-Z_]\w*)\b")
_TAG_KEYWORDS = {
    "if", "elif", "for", "in", "not", "and", "or", "is", "none", "true", "false",
}
_RAW_RE = re.compile(r"{%-?\s*raw\s*-?%}.*?{%-?\s*endraw\s*-?%}", re.DOTALL)
_COMMENT_RE = re.compile(r"{#.*?#}", re.DOTALL)


def extract_templates(repo: Path) -> dict:
    """{"sys_prompt": str|None, "agent_prompt": str|None, "supports_override": bool}"""
    path = repo / TEMPLATE_FILE
    out = {"sys_prompt": None, "agent_prompt": None, "supports_override": False}
    try:
        source = path.read_text()
    except OSError:
        return out
    out["supports_override"] = "load_prompt_overrides" in source
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return out
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name) or target.id not in TEMPLATE_NAMES:
            continue
        value = node.value
        # SYS_PROMPT = Template("""...""".strip())
        if isinstance(value, ast.Call) and value.args:
            arg = value.args[0]
            while isinstance(arg, ast.Call) and isinstance(arg.func, ast.Attribute):
                arg = arg.func.value  # unwrap "...".strip()
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                out[TEMPLATE_NAMES[target.id]] = arg.value.strip()
    return out


def placeholders(template_src: str) -> set:
    """Variables the template actually renders. jinja's own parser when
    available (exact: filters, expressions, comments, raw blocks); a regex
    approximation otherwise or when the source doesn't parse."""
    try:
        import jinja2
        from jinja2 import meta

        ast = jinja2.Environment().parse(template_src)
        return set(meta.find_undeclared_variables(ast))
    except ImportError:
        pass
    except Exception:
        pass  # invalid jinja: validate_rewrite reports that separately
    src = _COMMENT_RE.sub("", _RAW_RE.sub("", template_src))
    names = set(_VAR_RE.findall(src))
    for expr in _TAG_RE.findall(src):
        for ident in _IDENT_RE.findall(expr):
            if ident not in _TAG_KEYWORDS:
                names.add(ident)
    return names


def validate_rewrite(original: str | None, rewrite: str | None, label: str) -> list:
    issues = []
    if not rewrite:
        return issues
    if original:
        missing = placeholders(original) - placeholders(rewrite)
        if missing:
            issues.append(
                f"{label}: dropped placeholders the runner fills: "
                + ", ".join(sorted(missing))
            )
    try:
        import jinja2

        # from_string compiles too: unknown filters/tests fail here instead
        # of at launch inside the sim
        jinja2.Environment().from_string(rewrite)
    except ImportError:
        pass
    except Exception as e:
        issues.append(f"{label}: not valid jinja — {e}")
    return issues


ARTIFACT_TYPES = ("text", "ppe", "health_center")


def _num(value, kind=float):
    try:
        return kind(value)
    except (TypeError, ValueError):
        return None


def validate_artifacts(artifacts: list, grid_size: int | None) -> list:
    """Mirrors OpenGridWorld._load_init_artifacts so problems surface in the
    UI instead of a crashed launch. Never raises: LLM output lands here."""
    issues = []
    for i, a in enumerate(artifacts or []):
        if not isinstance(a, dict) or not a.get("name"):
            issues.append(f"artifact {i}: needs at least a name")
            continue
        tag = f"artifact {i} ({a.get('name', '?')})"
        if a.get("type", "text") not in ARTIFACT_TYPES:
            issues.append(f"{tag}: type must be one of {ARTIFACT_TYPES}")
        pose, agent, role = a.get("pose"), a.get("agent"), a.get("role")
        if pose is not None and (agent is not None or role is not None):
            issues.append(f"{tag}: pose excludes agent/role (map vs inventory)")
        if pose is not None:
            coords = (
                [_num(c, int) for c in pose]
                if isinstance(pose, (list, tuple)) and len(pose) == 2
                else [None]
            )
            if None in coords:
                issues.append(f"{tag}: pose must be [x, y] with integer cells")
            elif grid_size and not all(0 <= c < grid_size for c in coords):
                issues.append(
                    f"{tag}: pose {pose} outside the {grid_size}x{grid_size} grid"
                )
        if a.get("type") == "health_center":
            if agent is not None or role is not None:
                issues.append(f"{tag}: a health center is fixed to the map; use pose")
            heal = _num(a.get("heal_probability", 0.2))
            if heal is None or not 0.0 <= heal <= 1.0:
                issues.append(f"{tag}: heal_probability must be in [0, 1]")
            hazard = _num(a.get("hazard_multiplier", 1.0))
            if hazard is None or not 0.0 <= hazard <= 1.0:
                issues.append(f"{tag}: hazard_multiplier must be in [0, 1]")
            radius = _num(a.get("radius", 1), int)
            if radius is None or radius < 0:
                issues.append(f"{tag}: radius must be an integer >= 0")
        lifespan = _num(a.get("lifespan", -1), int)
        if lifespan is None:
            issues.append(f"{tag}: lifespan must be an integer")
        elif lifespan != -1 and lifespan <= 0:
            issues.append(f"{tag}: lifespan must be > 0 or -1")
        step = _num(a.get("step", 0), int)
        if step is None:
            issues.append(f"{tag}: step must be an integer")
        elif step < 0:
            issues.append(f"{tag}: step cannot be negative")
    return issues


def validate_personas(personas: list) -> list:
    issues = []
    for i, p in enumerate(personas or []):
        if isinstance(p, str):
            continue
        if not isinstance(p, dict) or not p.get("persona"):
            issues.append(f"persona {i}: needs a 'persona' text")
        elif int(p.get("count", 1) or 1) < 1:
            issues.append(f"persona {i}: count must be >= 1")
    return issues
