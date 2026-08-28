"""The scenario designer: one litellm call that rewrites the agent prompts,
personas and seeded artifacts to fit a natural-language scenario.

litellm routes the model name to its provider (claude-* -> Anthropic,
gpt-* -> OpenAI, ...), so a single optional api_key override covers whichever
provider the chosen model needs; otherwise provider env vars apply.
"""

import json
import re

DEFAULT_MODEL = "claude-opus-5"

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)

#: a candidate object must look like the design reply, or an example object
#: embedded in the prose (or an example fence) would win over the real one
_EXPECTED_KEYS = ("sys_prompt", "agent_prompt", "personas", "init_artifacts",
                  "design_notes")

RESPONSE_SHAPE = """{
  "sys_prompt": "<full rewritten system prompt template (jinja source)>",
  "agent_prompt": "<full rewritten per-step prompt template (jinja source)>",
  "personas": [{"persona": "...", "name": "...", "role": "...", "count": 1}],
  "init_artifacts": [{"name": "...", "type": "text|ppe|health_center",
                      "payload": "...", "pose": [x, y] , "agent": null,
                      "role": null, "lifespan": -1, "step": 0}],
  "suggested_params": [{"name": "<param name>", "value": <value>, "why": "..."}],
  "design_notes": "<what you changed and why, 3-6 sentences>"
}"""

SYSTEM_PROMPT = """You adapt TerraLingua simulation content to a scenario the user \
describes. TerraLingua is a multi-agent LLM simulation: "beings" live on a toroidal \
grid, see a small neighbourhood, eat food for energy, broadcast messages, write text \
artifacts, and optionally catch a transmissible infection. Each being is driven by an \
LLM that receives a SYSTEM PROMPT (identity + world rules, rendered once) and a \
PER-STEP PROMPT (observation, messages, energy, inventory, memory, available \
actions), both jinja2 templates rendered by the engine.

Rewrite the templates so their tone, framing and vocabulary fit the user's scenario, \
while remaining a faithful interface to the same engine. HARD RULES:

1. Keep EVERY jinja placeholder ({{ ... }}) and control block ({% if/for ... %}) that \
the originals use, with identical variable names. You may move them, reword the prose \
around them, and add scenario flavour, but a render with the same variables must \
still make sense.
2. In the per-step prompt, keep the "Reply Format" JSON block byte-compatible: the \
same fields (action, message, params, internal_memory inside its {% if %} block) in a \
```json fence — the engine parses replies against it.
3. Do not invent mechanics: no new actions, stats or rules the engine does not have. \
Scenario colour must stay narrative ("the fever spreading in the valley"), never \
mechanical promises ("you gain 5 strength").
4. personas: each entry is {persona, name, role, count}; persona is 2-4 sentences of \
identity/behaviour written in second person ("You are ..."); name may be null (one \
will be drawn); role is a short lowercase job tag shared by a group, or null; count \
>= 1. Persona texts must not contradict the hard world rules.
5. init_artifacts: types are "text" (payload = its inscription), "ppe" (protective \
gear) and "health_center" (fixed to the map, optional heal_probability, \
hazard_multiplier, radius). Each has a unique snake_case name. pose = [x, y] on the \
map XOR agent/role = seeded into inventories (agent names a being, role targets \
every being with that persona role). lifespan -1 = forever; step = timestep it \
appears. Poses must fit the grid the user runs (see current params).
6. suggested_params: only parameter names from the provided catalogue, values of the \
right type, each with a one-line why. Suggest only what the scenario genuinely needs.

Reply with ONLY a JSON object of this exact shape (no prose outside it):
""" + RESPONSE_SHAPE

REFINE_PROMPT = """Your previous reply above is the CURRENT design state — the \
user may have hand-edited it since, so treat it (not your memory of what you \
sent) as the ground truth to build on. Refine it according to the feedback \
below: change only what the feedback calls for and carry everything else over \
unchanged. Every hard rule still applies. Reply with ONLY the complete JSON \
object in the same shape — the full design, never a diff or a fragment.

FEEDBACK:
{feedback}"""


def build_user_prompt(
    description: str,
    sys_prompt: str,
    agent_prompt: str,
    personas: list,
    artifacts: list,
    param_catalog: list,
) -> str:
    catalog = "\n".join(
        f"- {p['name']} (current: {json.dumps(p.get('value'))}): {p.get('help', '')}"
        for p in param_catalog
    )
    return f"""SCENARIO TO SIMULATE:
{description.strip()}

CURRENT SYSTEM PROMPT TEMPLATE:
<<<SYS
{sys_prompt}
SYS

CURRENT PER-STEP PROMPT TEMPLATE:
<<<STEP
{agent_prompt}
STEP

CURRENT PERSONAS (adapt, replace or extend):
{json.dumps(personas or [], indent=1)}

CURRENT SEEDED ARTIFACTS (adapt, replace or extend):
{json.dumps(artifacts or [], indent=1)}

PARAMETER CATALOGUE (for suggested_params; "current" is what the user has set):
{catalog}
"""


def _looks_like_design(obj) -> bool:
    return isinstance(obj, dict) and any(k in obj for k in _EXPECTED_KEYS)


def _extract_json(text: str) -> dict:
    # strict=False: the reply embeds multi-line templates, and models emit
    # literal newlines inside JSON strings whenever json mode isn't enforced
    decoder = json.JSONDecoder(strict=False)
    fallback = None
    candidates = [m.group(1) for m in _JSON_FENCE_RE.finditer(text)] + [text]
    for candidate in candidates:
        try:
            obj = decoder.decode(candidate.strip())
        except json.JSONDecodeError:
            continue
        if _looks_like_design(obj):
            return obj
        if fallback is None and isinstance(obj, dict):
            fallback = obj
    # prose around the object: scan brace positions until one parses
    idx, attempts = text.find("{"), 0
    while idx != -1 and attempts < 50:
        try:
            obj, _ = decoder.raw_decode(text, idx)
            if _looks_like_design(obj):
                return obj
            if fallback is None and isinstance(obj, dict):
                fallback = obj
        except json.JSONDecodeError:
            pass
        idx, attempts = text.find("{", idx + 1), attempts + 1
    if fallback is not None:
        return fallback
    raise ValueError("designer reply held no JSON object")


def _clean(result: dict) -> dict:
    personas = []
    for p in result.get("personas") or []:
        if isinstance(p, str):
            p = {"persona": p}
        entry = {"persona": str(p.get("persona", "")).strip()}
        if p.get("name"):
            entry["name"] = str(p["name"])
        if p.get("role"):
            entry["role"] = str(p["role"])
        try:
            count = int(p.get("count", 1) or 1)
        except (TypeError, ValueError):
            count = 1
        if count > 1:
            entry["count"] = count
        if entry["persona"]:
            personas.append(entry)
    artifacts = []
    for a in result.get("init_artifacts") or []:
        if not isinstance(a, dict) or not a.get("name"):
            continue
        artifacts.append({k: v for k, v in a.items() if v is not None})
    suggested = []
    for s in result.get("suggested_params") or []:
        if isinstance(s, dict) and s.get("name"):
            suggested.append(
                {
                    "name": str(s["name"]),
                    "value": s.get("value"),
                    "why": str(s.get("why", "")),
                }
            )
    return {
        "sys_prompt": (str(result.get("sys_prompt") or "")).strip(),
        "agent_prompt": (str(result.get("agent_prompt") or "")).strip(),
        "personas": personas,
        "init_artifacts": artifacts,
        "suggested_params": suggested,
        "design_notes": (str(result.get("design_notes") or "")).strip(),
    }


def suggested_models(providers: set | None = None) -> list[str]:
    """Chat-capable models litellm knows how to price/route, majors first.

    With `providers`, only models of those litellm providers — the caller
    passes the providers whose API keys are actually available."""
    import litellm

    models = sorted(
        name
        for name, info in litellm.model_cost.items()
        if isinstance(info, dict)
        and info.get("mode") == "chat"
        and (not providers or info.get("litellm_provider") in providers)
    )
    featured = [m for m in models if m.startswith(("claude", "gpt", "o3", "o4"))]
    rest = [m for m in models if m not in set(featured)]
    return featured + rest


def design_messages(
    description: str,
    sys_prompt: str,
    agent_prompt: str,
    personas: list,
    artifacts: list,
    param_catalog: list,
) -> list:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": build_user_prompt(
                description, sys_prompt, agent_prompt,
                personas, artifacts, param_catalog,
            ),
        },
    ]


def refine_messages(
    description: str,
    sys_prompt: str,
    agent_prompt: str,
    personas: list,
    artifacts: list,
    param_catalog: list,
    current_design: dict,
    feedback: str,
) -> list:
    """One extra round-trip, no server-side session: the current on-screen
    design (manual edits included) is replayed as the assistant's own turn."""
    return design_messages(
        description, sys_prompt, agent_prompt, personas, artifacts, param_catalog
    ) + [
        {"role": "assistant", "content": json.dumps(current_design, indent=1)},
        {"role": "user", "content": REFINE_PROMPT.format(feedback=feedback)},
    ]


def complete(messages: list, model: str, api_key: str | None) -> dict:
    import litellm

    kwargs = {
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "max_tokens": 16000,
        "timeout": 600,
        "drop_params": True,  # silently sheds params a provider lacks
    }
    if api_key:
        kwargs["api_key"] = api_key
    try:
        resp = litellm.completion(response_format={"type": "json_object"}, **kwargs)
    except litellm.ContextWindowExceededError:
        raise  # a retry without response_format cannot fix an oversized prompt
    except litellm.BadRequestError:
        # provider rejects response_format outright; the prompt already
        # demands bare JSON, so retry plain (auth/rate-limit errors propagate)
        resp = litellm.completion(**kwargs)
    text = resp.choices[0].message.content or ""
    return _clean(_extract_json(text))
