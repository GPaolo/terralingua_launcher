# TerraLingua Launcher

A web page that configures and launches [TerraLingua](https://github.com/cognizant-ai-lab/terralingua) simulations.

The launcher drives a **working directory** with a **Python interpreter**:

- The working directory holds the presets (`*.preset.yaml`) and any scenario package. Runs write their logs under `logs/` inside it, unless `TL_LOGS_DIR` says otherwise. This is the folder you would run `terralingua` from.
- The interpreter has `terralingua` installed. It runs the simulations.

The launcher never imports TerraLingua itself. It runs `python -m terralingua.config` in the interpreter: `describe` for the settings and their dependencies, `evaluate` for the state of a configuration, `presets`, `artifact-types` and `version`. It also asks that interpreter where a preset's scenario package lives. New settings added to TerraLingua appear in the form without changes to the launcher.

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
- "Update preset" writes the current configuration back to the selected preset's file, so your changes become part of it; it can also change just the description. Built-in presets cannot be updated. "Save new preset" writes it as a new preset file in the working directory instead; the file name is the preset name with spaces and punctuation replaced by `_`. In both cases the paths TerraLingua resolved relative to the source preset, and the instructions, personas and artifacts files, are written relative to the preset file, as TerraLingua reads them; a file outside the working directory keeps its absolute path.
- Launch asks first when changed settings are not saved to a preset, or an editor has unsaved changes, and says what the run will and will not use.
- "Resume from the latest checkpoint" adds `--resume`.

**Artifacts tab**

Artifact sets to seed at the start of a run. Each entry has a name, a type from the ones the preset's scenario knows, a payload, a cell or node, a lifespan and the type's own parameters. "In the configuration" shows the folder the current configuration names through `env.init_artifacts_path`, or through a scenario option of that name; the editor opens it, and "Save" writes it back in place when it lies under the working directory and holds at most one JSON file. The list below it shows the sets found in the folders that matter: where the setting reads them, beside the preset, and the launcher's own `launcher_content/artifacts/`. "Save as…" asks for a name and a folder, suggests those folders with the one the setting reads from first, lets you browse the folders under the working directory, and shows the value "Use in launch" will set. "Open…" browses the working directory for a set. "Use in launch" points the setting at the set in the editor.

**Personas tab**

Persona lists for the first beings of a run: a persona text, an optional name and a count per entry. Works like the Artifacts tab: the list named by `agent.personas_path`, or by a scenario option of that name, opens by itself and can be changed in place, and new lists go wherever you choose under the working directory. A relative scenario option is read from the scenario package's folder, as scenarios do, so a list saved there gets a plain relative value; a list elsewhere gets an absolute path, which then lands in the preset if you update it. The Launch tab shows an "Edit in Artifacts", "Edit in Personas" or "Show in Scenario AI" link under a setting whose file the launcher can open.

**Scenario AI tab**

"Current instructions" is an editor for the file that `agent.scenario_specific_instructions` names, as it is on disk; TerraLingua renders it with Jinja at run time. "Save" writes it back, "Save as…" writes it where you choose, "New" starts an empty text, "Open…" loads any text file under the working directory, and "Use in launch" points the setting at the file in the editor. Beside it, describe a scenario in plain language. A model writes the instructions text, a persona list, an artifact set and suggested settings, from the preset's settings, the current instructions and the artifact types the scenario knows. Review the result, change the text, ask for changes, then apply: the files get the chosen name in the chosen folder (the scenario's folder is suggested first, then the preset's, then `launcher_content/`, which keeps one subfolder per kind), and the Launch form gets the instructions, personas and artifacts settings and the accepted settings. The model is any name `litellm` routes, `claude-opus-5-5` by default. The key comes from the environment or the working directory's `.env`; a key typed in the page is used for one call and never stored.

**Console tab**

Launched runs and scenario tools, their status, and their live output. A tool shows the address of its page. Stop sends a termination signal; Kill forces it. Process output is kept under `<workdir>/logs/_launcher/`.

## Scenario tools

A scenario may ship a viewer or an anthropologist as a subpackage with that name, runnable as `python -m <scenario>.viewer --logs <folder> --port <n>`. TerraLingua reports them for a preset. The Launch and Console tabs then show an "Open viewer" or "Open anthropologist" button, which starts the tool with the working directory's `logs/` folder and lists it in the Console with a link to its page.

By default a tool takes any free port. When you use the launcher through a forwarded port, set the ports the tools may use in the Settings panel, for example `8990`, and forward them too.

Runs and tools keep going when the launcher stops. After a restart they are not listed in the Console; stop them from a terminal.

## Keys

The header shows whether `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `AWS_BEARER_TOKEN_BEDROCK` are set. The launcher reads them from its own environment and from `<workdir>/.env`. Launched runs inherit them.

## Development

```bash
pip install -e '.[test]'
pytest
```

The server tests drive a real TerraLingua installation. Set `TL_LAUNCHER_TEST_WORKDIR` to a checkout that holds the `example` scenario to run the scenario tests too.
