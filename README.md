# TerraLingua Launcher

A web page that configures and launches [TerraLingua](https://github.com/cognizant-ai-lab/terralingua) simulations.

The launcher drives a **working directory** with a **Python interpreter**:

- The working directory holds the presets (`*.preset.yaml`) and any scenario package. Runs write their logs under `logs/` inside it, unless `TL_LOGS_DIR` says otherwise. This is the folder you would run `terralingua` from.
- The interpreter has `terralingua` installed. It runs the simulations.

The launcher never imports TerraLingua itself. It asks the interpreter for the list of settings, their dependencies and the state of a configuration, through `python -m terralingua.config describe` and `evaluate`. It asks the same interpreter for the preset list and the installed version. New settings added to TerraLingua appear in the form without changes to the launcher.

## Install

```bash
pip install git+https://github.com/GPaolo/terralingua_launcher.git
terralingua-launcher --workdir /path/to/your/experiments --python /path/to/env/bin/python
```

Or from a clone, without installing:

```bash
git clone https://github.com/GPaolo/terralingua_launcher.git
pip install -r terralingua_launcher/requirements.txt
python -m terralingua_launcher --workdir /path/to/your/experiments --python /path/to/env/bin/python
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

**Console tab**

Launched runs, their status, and their live output. Stop sends a termination signal; Kill forces it. Process output is kept under `<workdir>/logs/_launcher/`.

## Keys

The header shows whether `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `AWS_BEARER_TOKEN_BEDROCK` are set. The launcher reads them from its own environment and from `<workdir>/.env`. Launched runs inherit them.

## Development

```bash
pip install -e '.[test]'
pytest
```

The server tests drive a real TerraLingua checkout. Set `TL_LAUNCHER_TEST_WORKDIR` to its path.
