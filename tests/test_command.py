from terralingua_launcher import command

FIELDS = {
    "env.grid_size": {"aliases": ["grid_size"], "type": "int"},
    "env.colors": {"aliases": ["colors"], "type": "bool", "schema": {"type": "boolean"}},
    "run.seed": {"aliases": ["seed"], "type": "int | None"},
    "env.graph.seed": {"aliases": ["seed", "graph.seed"], "type": "int | None"},
    "run.ports": {"aliases": ["ports"], "type": "list"},
    "env.energy_death": {"aliases": ["energy_death"], "type": "bool | None", "schema": {"anyOf": [{"type": "boolean"}, {"type": "null"}]}},
}


def test_core_overrides_use_the_short_alias_and_the_cli_syntax():
    argv = command.build_argv(
        "core",
        {"env.grid_size": 12, "env.colors": False, "run.ports": [8000, 8001]},
        FIELDS,
        resume=True,
    )
    assert argv == [
        "core", "--grid_size", "12", "--no-colors", "--ports", "[8000, 8001]", "--resume",
    ]


def test_true_boolean_is_a_bare_flag():
    assert command.build_argv(None, {"env.colors": True}, FIELDS) == ["--colors"]


def test_an_optional_boolean_is_a_bare_flag_or_null():
    overrides = {"env.energy_death": True}
    assert command.build_argv(None, overrides, FIELDS) == ["--energy_death"]
    assert command.build_argv(None, {"env.energy_death": False}, FIELDS) == ["--no-energy_death"]
    assert command.build_argv(None, {"env.energy_death": None}, FIELDS) == ["--energy_death", "null"]


def test_an_alias_two_fields_answer_to_is_never_used():
    argv = command.build_argv(None, {"env.graph.seed": 7, "run.seed": None}, FIELDS)
    assert argv == ["--graph.seed", "7", "--run.seed", "null"]


def test_unknown_field_falls_back_to_its_path():
    assert command.build_argv(None, {"env.unknown": "x"}, FIELDS) == ["--env.unknown", "x"]


def test_scenario_options_travel_as_one_json_dictionary():
    argv = command.build_argv(
        "ebola",
        {
            "run.scenario_options.burials": False,
            "run.scenario_options.health_center.radius": 3,
            "env.grid_size": 9,
        },
        FIELDS,
    )
    assert argv == [
        "ebola", "--scenario_options", '{"burials": false, "health_center": {"radius": 3}}',
        "--grid_size", "9",
    ]


def test_scenario_options_merges_a_whole_dictionary_with_dotted_paths():
    overrides = {
        "run.scenario_options": {"lifespan": 10, "health_center": {"pose": [1, 1]}},
        "run.scenario_options.health_center.radius": 2,
    }
    options = command.scenario_options(overrides)
    assert options == {"lifespan": 10, "health_center": {"pose": [1, 1], "radius": 2}}
    assert overrides["run.scenario_options"] == {"lifespan": 10, "health_center": {"pose": [1, 1]}}


def test_normalized_folds_the_options_and_keeps_the_rest():
    overrides = {"env.grid_size": 9, "run.scenario_options.burials": False, "run.scenario_options": {"lifespan": 2}}
    assert command.normalized(overrides) == {
        "env.grid_size": 9, "run.scenario_options": {"lifespan": 2, "burials": False},
    }
    assert command.normalized({"env.grid_size": 9, "run.scenario_options": {}}) == {"env.grid_size": 9}


def test_no_preset_and_no_overrides_gives_an_empty_command():
    assert command.build_argv(None, {}, FIELDS) == []


def test_command_string_quotes_json():
    argv = command.build_argv("ebola", {"run.ports": [1, 2]}, FIELDS)
    assert command.command_string("/usr/bin/python3", argv) == (
        "/usr/bin/python3 -m terralingua ebola --ports '[1, 2]'"
    )
