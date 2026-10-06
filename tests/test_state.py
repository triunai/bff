import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from bff import state


class StateFile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.path = self.dir / "sub" / "state.json"

    def test_missing_file(self):
        self.assertEqual(state.load(self.path), {"schema_version": 1})
        self.assertFalse(self.path.exists())

    def test_round_trip_format(self):
        state.save(self.path, {"b": 1, "a": {"z": [1]}})
        text = self.path.read_text()
        self.assertTrue(text.endswith("}\n"))
        self.assertEqual(text, json.dumps({"a": {"z": [1]}, "b": 1, "schema_version": 1}, indent=2, sort_keys=True) + "\n")
        self.assertEqual(state.load(self.path)["a"], {"z": [1]})

    def test_schema_version_only_set_when_absent(self):
        state.save(self.path, {"schema_version": 7})
        self.assertEqual(state.load(self.path)["schema_version"], 7)

    def test_unknown_nested_keys_survive_update(self):
        original = {"schema_version": 1, "future": {"deep": {"x": [1, {"y": 2}]}}, "bff": {"active": "a", "extra": True}}
        state.save(self.path, original)
        state.update(self.path, lambda d: d["bff"].update(previous="p"))
        loaded = state.load(self.path)
        self.assertEqual(loaded["future"], original["future"])
        self.assertEqual(loaded["bff"], {"active": "a", "extra": True, "previous": "p"})

    def test_corrupt_file_raises_and_is_untouched(self):
        self.path.parent.mkdir()
        self.path.write_bytes(b'{"bff": ')
        with self.assertRaises(ValueError) as caught:
            state.update(self.path, lambda d: d.update(x=1))
        self.assertIn(str(self.path), str(caught.exception))
        self.assertEqual(self.path.read_bytes(), b'{"bff": ')

    def test_non_object_raises(self):
        self.path.parent.mkdir()
        self.path.write_bytes(b"[1, 2]\n")
        with self.assertRaises(ValueError) as caught:
            state.load(self.path)
        self.assertIn(str(self.path), str(caught.exception))
        self.assertEqual(self.path.read_bytes(), b"[1, 2]\n")

    def test_higher_schema_version_still_loads(self):
        self.path.parent.mkdir()
        self.path.write_text('{"schema_version": 99, "new": 1}')
        self.assertEqual(state.load(self.path), {"schema_version": 99, "new": 1})

    def test_failed_replace_keeps_original_and_leaves_no_temp(self):
        state.save(self.path, {"keep": "me"})
        before = self.path.read_bytes()
        with mock.patch("os.replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                state.save(self.path, {"keep": "changed"})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ["state.json"])

    def test_update_returns_mutated_data(self):
        data = state.update(self.path, lambda d: d.update(method="script"))
        self.assertEqual(data["method"], "script")
        self.assertEqual(state.load(self.path), data)


class Config(unittest.TestCase):
    def test_defaults(self):
        self.assertIs(state.get_config({}, "update.check"), True)
        self.assertIs(state.get_config({}, "update.auto"), False)
        self.assertIs(state.get_config({"config": {"update": {}}}, "update.auto"), False)

    def test_unknown_key(self):
        with self.assertRaises(ValueError):
            state.get_config({}, "nope")
        with self.assertRaises(ValueError):
            state.set_config({}, "nope", "true")

    def test_parse_every_spelling(self):
        for raw in ("true", "YES", "On", "1", " True "):
            self.assertIs(state.get_config(state.set_config({}, "update.auto", raw), "update.auto"), True)
        for raw in ("false", "No", "OFF", "0"):
            self.assertIs(state.get_config(state.set_config({}, "update.check", raw), "update.check"), False)

    def test_bad_value_lists_allowed(self):
        data = {}
        with self.assertRaises(ValueError) as caught:
            state.set_config(data, "update.check", "maybe")
        self.assertIn("true", str(caught.exception))
        self.assertIn("off", str(caught.exception))
        self.assertEqual(data, {})

    def test_set_preserves_siblings_and_replaces_non_dict(self):
        data = {"config": {"update": {"check": True, "other": 5}, "x": 1}}
        state.set_config(data, "update.auto", "yes")
        self.assertEqual(data["config"], {"update": {"check": True, "other": 5, "auto": True}, "x": 1})
        broken = {"config": {"update": "oops"}}
        state.set_config(broken, "update.check", "no")
        self.assertEqual(broken["config"]["update"], {"check": False})

    def test_update_disabled(self):
        self.assertFalse(state.update_disabled({}, env={}))
        self.assertFalse(state.update_disabled({}, env={"BFF_NO_UPDATE_CHECK": ""}))
        self.assertFalse(state.update_disabled({}, env={"BFF_NO_UPDATE_CHECK": "0"}))
        self.assertTrue(state.update_disabled({}, env={"BFF_NO_UPDATE_CHECK": "1"}))
        self.assertTrue(state.update_disabled({}, env={"BFF_NO_UPDATE_CHECK": "yes"}))
        off = state.set_config({}, "update.check", "false")
        self.assertTrue(state.update_disabled(off, env={}))

    def test_update_disabled_defaults_to_real_environ(self):
        with mock.patch.dict(os.environ, {"BFF_NO_UPDATE_CHECK": "1"}):
            self.assertTrue(state.update_disabled({}))


if __name__ == "__main__":
    unittest.main()
