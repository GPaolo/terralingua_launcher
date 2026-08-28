# TerraLingua Launcher

Web UI for configuring and launching TerraLingua simulations.

## Install

From inside a TerraLingua checkout (its environment already has every dependency):

```bash
python -m terralingua_launcher        # → http://127.0.0.1:7000
```

Standalone:

```bash
git clone git@github.com:GPaolo/terralingua_launcher.git
cd terralingua_launcher
pip install -r requirements.txt
cd .. && python -m terralingua_launcher --repo /path/to/terralingua --python /path/to/terralingua_env/python
```

or install it and run from anywhere:

```bash
pip install ./terralingua_launcher
terralingua-launcher --repo /path/to/terralingua --python /path/to/terralingua_env/python
```

`--repo` is the TerraLingua checkout to drive, `--python` the interpreter of its
environment (the one that runs the sims). Both are remembered after the first
run and can be changed from the header chip in the UI.

## Usage

- **Launch** — set the simulation parameters (ⓘ explains each one), save/load
  named configs, check the command preview, tick *open dashboard* to also start
  `python -m viz`, hit **▶ Launch**. *resume* continues from the latest checkpoint.
- **Personas** — edit `{persona, name, role, count}` entries or load an existing
  personas JSON; **Save & use** writes the file and sets `--personas`.
- **Artifacts** — edit environment-seeded artifacts (text / ppe / health_center,
  placed on the map or into inventories); **Save & use** sets `--init_artifacts`.
- **Scenario AI** — describe a scenario in plain language; an LLM rewrites the
  agent prompt templates and proposes personas, artifacts and parameter values.
  Pick any litellm-routable model; the API key comes from the environment, the
  repo's `.env`, or the key field (used per call, never stored). **Refine**
  iterates on the result, **✓ apply all** pushes the suggested params into the
  launch form, **Save bundle** wires everything into the launch form
  (`--prompt_templates`, `--personas`, `--init_artifacts`).
- **Console** — live logs of launched runs, stop / force-kill.

Saved configs and bundles go to `<repo>/launcher_configs/`, process logs to
`<repo>/logs/_launcher/`, launcher settings to `~/.terralingua_launcher.json`.
