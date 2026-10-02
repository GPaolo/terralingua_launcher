"""The scenario designer: one model call that writes scenario content for a run.

From a description in plain language, the model writes the instructions text
for `agent.scenario_specific_instructions`, a persona list, an artifact set and
suggested settings. The page saves them as content files and sets the
overrides. The model only proposes; TerraLingua validates the settings.
"""

import json
import re

import litellm

DEFAULT_MODEL = "claude-opus-5-5"

#: environment variable that holds the key of a provider, as litellm names providers
KEY_VARS = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "bedrock": "AWS_BEARER_TOKEN_BEDROCK"}

REPLY_SHAPE = """{
  "instructions": "<Markdown text appended to every being's system prompt>",
  "personas": [{"persona": "You are ...", "name": null, "count": 1}],
  "artifacts": [{"name": "snake_case_name", "art_type": "text", "payload": "...", "pose": [3, 4], "lifespan": -1, "movable": true, "params": {}}],
  "suggested_params": [{"path": "env.init_agents", "value": 12, "why": "one sentence"}],
  "design_notes": "<what you wrote and why, 3 to 6 sentences>"
}"""

SYSTEM_PROMPT = """You write content for TerraLingua, a simulation in which beings driven by a language model live in a shared world. Each being sees a small neighbourhood, loses one energy per step, eats food for energy when food is on, sends short broadcast messages, writes text artifacts, and may die when its energy or its time runs out. Each being gets a system prompt with the world rules, then the run's instructions text, then its personality traits and its persona.

You receive a description of the scenario the user wants, the current settings, the artifact types the world knows, and the current instructions text when there is one. You reply with one JSON object and nothing else, in this shape:

{reply_shape}

Rules:
1. instructions: Markdown. State facts about this scenario's world in plain, simple sentences. Do not repeat the world rules above: energy, food, messages, artifacts and death are already in every being's prompt. Do not tell beings what to do. Do not invent mechanics the engine does not have: no new actions, no stats, no capacities, no rules about rewards. Keep every fact of the current instructions text that still applies.
2. personas: one entry per persona. persona is 1 to 4 sentences in the second person ("You are ..."). name is a string or null; a name applies only when count is 1. count is a whole number of at least 1. The first beings created get them in order.
3. artifacts: name is unique and snake_case. art_type is one of the types listed. payload is the content of the artifact; for a text artifact it is the inscription. pose is [row, col] on a grid world or a node id string on a graph world. lifespan is a whole number of steps, -1 for forever. movable says whether beings can carry it. params holds the type's own parameters only.
4. suggested_params: only settings from the list, with a value of the right type, and one sentence why. Suggest few, and only when the scenario needs them.
5. Write every text in simple English: short sentences, one idea per sentence, no metaphors."""


def key_for(model: str, env: dict) -> str | None:
    """The key the environment holds for this model's provider, or None."""
    try:
        provider = litellm.get_llm_provider(model)[1]
    except Exception:  # litellm raises its own error for a name it does not know
        return None
    return env.get(KEY_VARS.get(provider, "")) or None


def catalogue(fields: dict, values: dict) -> str:
    """One line per setting: path, type, choices or bounds, current value, description."""
    lines = []
    for path, field in sorted(fields.items()):
        schema = field.get("schema") or {}
        detail = ""
        if schema.get("enum"):
            detail = f" one of {json.dumps(schema['enum'])}"
        elif "minimum" in schema or "maximum" in schema:
            detail = f" from {schema.get('minimum', '-inf')} to {schema.get('maximum', 'inf')}"
        current = json.dumps(values.get(path, field.get("default")))
        lines.append(f"- {path} ({field.get('type')}{detail}; now {current}): {field.get('description', '')}")
    return "\n".join(lines)


def user_prompt(description: str, context: dict, previous: dict | None = None, feedback: str = "") -> str:
    """The request to the model: the description, the world, the settings and the current content."""
    types = "\n".join(
        f"- {t['name']}: {t['description']}" + (f" Parameters: {', '.join(t['params'])}." if t.get("params") else "")
        for t in context["artifact_types"]
    )
    parts = [
        f"Scenario description:\n{description.strip()}",
        f"World type: {context['world_type']}. Initial beings: {context['init_agents']}.",
        f"Artifact types:\n{types}",
        f"Current instructions text ({context['instructions_source']}):\n{context['instructions_text'] or '(none)'}",
        f"Settings (path, type, current value, description):\n{catalogue(context['fields'], context['values'])}",
    ]
    if previous:
        parts.append(f"Your previous reply:\n{json.dumps(previous, indent=2)}")
    if feedback.strip():
        parts.append(f"The user asks for these changes:\n{feedback.strip()}")
    return "\n\n".join(parts)


def parse_reply(text: str) -> dict:
    """The JSON object in the model's reply, fenced or bare."""
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    raw = fenced.group(1) if fenced else text[text.find("{"):text.rfind("}") + 1]
    try:
        design = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"the model did not reply with valid JSON: {exc}") from exc
    if not isinstance(design, dict):
        raise ValueError("the model did not reply with a JSON object")
    return design


def check_design(design: dict, context: dict) -> list[dict]:
    """Problems in a design: {"where": part, "message": text}. An empty list means it can be applied."""
    found = []

    def note(part: str, message: str) -> None:
        found.append({"where": part, "message": message})

    if not str(design.get("instructions") or "").strip():
        note("instructions", "instructions is empty")
    personas = design.get("personas")
    if not isinstance(personas, list):
        note("personas", "personas is not a list")
    else:
        for index, entry in enumerate(personas):
            if not isinstance(entry, dict) or not str(entry.get("persona") or "").strip():
                note("personas", f"persona {index + 1} has no text")
                continue
            count = entry.get("count", 1)
            if isinstance(count, bool) or not isinstance(count, int) or count < 1:
                note("personas", f"persona {index + 1} has an invalid count {count!r}")
    artifacts = design.get("artifacts")
    known = {t["name"] for t in context["artifact_types"]}
    if not isinstance(artifacts, list):
        note("artifacts", "artifacts is not a list")
    else:
        names = [a.get("name") for a in artifacts if isinstance(a, dict)]
        if len(names) != len(set(names)):
            note("artifacts", "artifact names are not unique")
        for index, entry in enumerate(artifacts):
            label = f"artifact {index + 1}"
            if not isinstance(entry, dict):
                note("artifacts", f"{label} is not an object")
                continue
            if not re.fullmatch(r"[a-z][a-z0-9_]*", str(entry.get("name") or "")):
                note("artifacts", f"{label} needs a snake_case name")
            if entry.get("art_type") not in known:
                note("artifacts", f"{label} has an unknown type {entry.get('art_type')!r}")
            if entry.get("payload") in (None, ""):
                note("artifacts", f"{label} has no payload")
            pose = entry.get("pose")
            if context["world_type"] == "grid":
                if not (isinstance(pose, list) and len(pose) == 2 and all(isinstance(p, int) for p in pose)):
                    note("artifacts", f"{label} needs a pose [row, col]")
            elif not isinstance(pose, str) or not pose:
                note("artifacts", f"{label} needs a node id as pose")
            lifespan = entry.get("lifespan", -1)
            if isinstance(lifespan, bool) or not isinstance(lifespan, int) or lifespan < -1:
                note("artifacts", f"{label} has an invalid lifespan {lifespan!r}")
            if not isinstance(entry.get("movable", True), bool):
                note("artifacts", f"{label} has an invalid movable value")
            if not isinstance(entry.get("params", {}), dict):
                note("artifacts", f"{label} has params that are not an object")
    suggested = design.get("suggested_params")
    if not isinstance(suggested, list):
        note("suggested_params", "suggested_params is not a list")
    else:
        for entry in suggested:
            path = entry.get("path") if isinstance(entry, dict) else None
            if path not in context["fields"]:
                note("suggested_params", f"suggested setting {path!r} does not exist")
            elif "value" not in entry:
                note("suggested_params", f"suggested setting {path} has no value")
    return found


def litellm_complete(model: str, messages: list[dict], api_key: str | None) -> str:
    response = litellm.completion(model=model, messages=messages, api_key=api_key)
    return response.choices[0].message.content or ""


def design(description: str, context: dict, model: str, api_key: str | None, complete=litellm_complete,
           previous: dict | None = None, feedback: str = "") -> dict:
    """Ask the model and return {"design": ..., "issues": [...]}."""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT.format(reply_shape=REPLY_SHAPE)},
        {"role": "user", "content": user_prompt(description, context, previous, feedback)},
    ]
    result = parse_reply(complete(model, messages, api_key))
    return {"design": result, "issues": check_design(result, context)}
