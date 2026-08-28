# TerraLingua Launcher

A web UI that replaces the launch shell scripts: every simulation parameter as
a form control with an ⓘ explanation, dropdowns where the config declares
choices, persona and seeded-artifact editors, an LLM scenario designer, and
one-click launch with the dashboard alongside.

## Install

Two interpreters are involved, and they don't have to be the same one:

- the one **running the launcher**, which needs this package's deps
  (`requirements.txt`);
- the one **running TerraLingua** — the "Python interpreter" in the launcher's
  settings — which needs TerraLingua's own deps. The launcher introspects and
  launches the target repo with that interpreter, never its own.

### Inside a TerraLingua checkout (simplest)

TerraLingua's environment already contains every launcher dependency, so with
the repo's env active and this package sitting at the checkout root:

```bash
cd <terralingua_checkout>
python -m terralingua_launcher            # → http://127.0.0.1:7000
```

### Standalone

```bash
git clone git@github.com:GPaolo/terralingua_launcher.git
cd terralingua_launcher
pip install -r requirements.txt

# run as a module (from the clone's parent dir)...
cd .. && python -m terralingua_launcher \
    --repo /path/to/terralingua --python /path/to/terralingua/env/python

# ...or install it and use the console script from anywhere
pip install ./terralingua_launcher
terralingua-launcher --repo /path/to/terralingua --python /path/to/terralingua/env/python
```

`--repo` / `--python` are only needed the first time (or use the header target
chip in the UI) — they persist in `~/.terralingua_launcher.json`.

For the Scenario AI tab, export `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
`GEMINI_API_KEY` / `AWS_BEARER_TOKEN_BEDROCK` (or keep them in the target
repo's `.env`, or paste a key in the tab itself).

## Independent by construction

The launcher never imports TerraLingua code. It:

- reads the parameter schema by running `introspect.py` **with the target
  repo's interpreter** — names, types, defaults, help texts and choice lists
  come from the `core/experiment/config.py` dataclasses, so params added or
  removed upstream appear or vanish from the UI with no launcher change;
- reads the agent prompt templates with an `ast` pass over
  `core/agents/prompt_templates.py`;
- launches runs as ordinary `python main.py --flag value …` subprocesses (the
  exact command is previewed and copyable in the UI).

Point it at any TerraLingua checkout via the header target chip or `--repo`.

## Tabs

- **Launch** — all params grouped as in the config, searchable, changed values
  marked and resettable. Save named configs (`launcher_configs/*.json`),
  reload them, launch with optional `--resume`, and tick *open dashboard* to
  bring up `python -m viz` alongside.
- **Personas** — card editor for `{persona, name, role, count}` entries; load
  any personas JSON found in the repo, save, and the launch form's
  `--personas` is pointed at the file automatically.
- **Artifacts** — same for environment-seeded artifacts (text / ppe /
  health_center, map pose vs inventory placement, appearance step, lifespan).
- **Scenario AI** — describe a scenario in plain language; an LLM (any
  litellm-routable model, API key from the environment/.env or typed into the
  key field, used per-call and never stored) rewrites the system and per-step
  prompt templates to fit while keeping every jinja placeholder, and proposes
  personas, seeded artifacts and parameter values. Everything is editable,
  validated (dropped placeholders, invalid artifacts, unknown params are
  flagged), and saved as a bundle under `launcher_configs/scenarios/<name>/`
  wired straight into the launch form — or downloaded as JSON files.
- **Console** — live tail of every launched process, stop / force-kill.

Prompt overrides launch through TerraLingua's `--prompt_templates` parameter;
on an older checkout without it the bundle still saves and the UI says the
prompts need manual wiring.

## Files it writes

| Where | What |
|---|---|
| `<repo>/launcher_configs/` | saved launch configs, persona/artifact files you save, scenario bundles |
| `<repo>/logs/_launcher/` | stdout/stderr of launched processes (ignored by the dashboard) |
| `~/.terralingua_launcher.json` | launcher settings and the last form state (never API keys) |
