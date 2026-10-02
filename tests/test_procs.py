import json

from terralingua_launcher import store
from terralingua_launcher.procs import _without_partial_char


def test_a_complete_text_is_kept():
    for text in ("plain", "café", "日本", "😀"):
        assert _without_partial_char(text.encode()) == text.encode()
    assert _without_partial_char(b"") == b""


def test_a_split_character_waits_for_the_next_read():
    for text in ("café", "日本", "😀"):
        data = text.encode()
        for cut in range(1, len(text[-1].encode())):
            assert _without_partial_char(data[:-cut]) == text[:-1].encode()


def test_state_file_must_hold_an_object(tmp_path, monkeypatch):
    path = tmp_path / "state.json"
    monkeypatch.setattr(store, "STATE_PATH", path)
    assert store.load_state() == {}
    path.write_text(json.dumps([1, 2]))
    assert store.load_state() == {}
    store.save_state({"workdir": "/x"})
    assert store.load_state() == {"workdir": "/x"}
