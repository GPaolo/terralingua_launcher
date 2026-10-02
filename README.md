# TerraLingua Launcher

A web page that configures and launches [TerraLingua](https://github.com/cognizant-ai-lab/terralingua) simulations.

The launcher drives a **working directory** with a **Python interpreter**:

- The working directory holds the presets (`*.preset.yaml`) and any scenario package. Runs write their logs under `logs/` inside it, unless `TL_LOGS_DIR` says otherwise. This is the folder you would run `terralingua` from.
- The interpreter has `terralingua` installed. It runs the simulations.

The launcher never imports TerraLingua itself. It runs `python -m terralingua.config` in the interpreter: `describe` for the settings and their dependencies, `evaluate` for the state of a configuration, `presets`, `artifact-types` and `version`. New settings added to TerraLingua appear in the form without changes to the launcher.

## Install

```bash
pip install git+https://github.com/GPaolo/terralingua_launcher.git
terralingua-launcher --workdir /path/to/your/experiments --python /path/to/env/bin/python
```

Or from a clone:

```bash
git clone https://github.com/GPaolo/terralingua_launcher.git
pip install -e terralingua_launcher
terralingua-launcher --workdir /path/to/your/experiments --python /path/to/env/bin/python
```

The page opens at http://127.0.0.1:7000 (`--host` and `--port` change this). Both paths are remembered in `~/.terralingua_launcher.json` and can be changed from the Settings panel. A remembered value is used when the option is not given. Without a remembered value, the working directory is the current folder, and the interpreter is `<workdir>/.venv/bin/python` if it exists, else the launcher's own interpreter.

## Use

**Launch tab**

- Pick a preset. The list holds TerraLingua's built-in presets and every preset file found under the working directory, each with its description.
- Edit settings in the form. Settings are grouped as in TerraLingua. A preset that selects a scenario adds a "Scenario options" group with the scenario's own settings.
- Settings that do not apply with the current values are hidden. For example, the grid size is hidden when the world type is a graph. "Show inactive settings" lists them greyed out with the reason.
- The diagnostics panel shows errors, warnings and notes from TerraLingua's validation. Launch stays disabled while there are errors.
- The command preview shows the exact `terralingua` command that will run. Only the changed settings appear on it; the preset carries the rest.
- "Save as preset" writes the current configuration as a new preset file in the working directory. The file name is the preset name with spaces and punctuation replaced by `_`.
- "Resume from the latest checkpoint" adds `--resume`.

**Artifacts tab**

Artifact sets to seed at the start of a run. Each entry has a name, a type from the ones the preset's scenario knows, a payload, a cell or node, a lifespan and the type's own parameters. A saved set is a folder with one JSON file under `launcher_content/artifacts/` in the working directory. "Use in launch" points `env.init_artifacts_path` at it.

**Personas tab**

Persona lists for the first beings of a run: a persona text, an optional name and a count per entry. A saved list is a JSON file under `launcher_content/personas/`. "Use in launch" points `agent.personas_path` at it. The Launch tab shows an "Edit in Artifacts" or "Edit in Personas" link under a setting that points at one of these files.

**Scenario AI tab**

Describe a scenario in plain language. A model writes the instructions text, a persona list, an artifact set and suggested settings, from the preset's settings and the artifact types the scenario knows. Review the result, change the text, ask for changes, then apply: the files go under `launcher_content/`, and the Launch form gets `agent.scenario_specific_instructions`, `agent.personas_path`, `env.init_artifacts_path` and the accepted settings. The model is any name `litellm` routes, `claude-opus-5-5` by default. The key comes from the environment or the working directory's `.env`; a key typed in the page is used for one call and never stored.

**Console tab**

Launched runs and scenario tools, their status, and their live output. A tool shows the address of its page. Stop sends a termination signal; Kill forces it. Process output is kept under `<workdir>/logs/_launcher/`.

## Scenario tools

A scenario may ship a viewer or an anthropologist as a subpackage with that name, runnable as `python -m <scenario>.viewer --logs <folder> --port <n>`. TerraLingua reports them for a preset. The Launch tab then shows an "Open viewer" or "Open anthropologist" button, which starts the tool on a free port with the working directory's `logs/` folder and lists it in the Console with a link to its page.

## Keys

The header shows whether `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `AWS_BEARER_TOKEN_BEDROCK` are set. The launcher reads them from its own environment and from `<workdir>/.env`. Launched runs inherit them.

## Development

```bash
pip install -e '.[test]'
pytest
```

The server tests drive a real TerraLingua checkout. Set `TL_LAUNCHER_TEST_WORKDIR` to its path.
