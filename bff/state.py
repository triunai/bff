"""One JSON state file, written atomically, that never drops fields it does not understand.

Lives at `paths.state_path()`. Stable shape (a later slice and the Osiris banner depend on it):

    {
      "schema_version": 1,
      "method": "script" | "uv" | "brew" | "dev" | "unknown",
      "bff": {"active": "<release id>", "previous": "<release id>" | null},
      "plugin": {"id": "tool-observer", "source": "<bb source string>", "version": "<x.y.z>", "previous_source": "<bb source string>" | null},
      "config": {"update": {"check": true, "auto": false}},
      "update_check": {"checked_at": "<UTC ISO-8601>", "current": "<x.y.z>", "latest": "<x.y.z>" | null,
                       "available": true | false, "prompted_on": "<YYYY-MM-DD>" | null}
    }

`update_check` is what the Osiris "Update available" banner reads. It is written only by bff, from the
once-a-day check. Osiris never calls the network. Use `update()` for every read-modify-write.
"""
import json
import os
import tempfile
from pathlib import Path

SCHEMA_VERSION = 1
CONFIG_KEYS = {"update.check": (bool, True), "update.auto": (bool, False)}
_TRUE = ("true", "yes", "on", "1")
_FALSE = ("false", "no", "off", "0")


def load(path):
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"schema_version": SCHEMA_VERSION}
    try:
        data = json.loads(text)
    except ValueError as error:
        raise ValueError("State file is not valid JSON: " + str(path) + " (" + str(error) + ")")
    if not isinstance(data, dict):
        raise ValueError("State file is not a JSON object: " + str(path))
    return data


def save(path, data):
    path = Path(path)
    data.setdefault("schema_version", SCHEMA_VERSION)
    text = json.dumps(data, indent=2, sort_keys=True) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=str(path.parent), prefix=".state-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, str(path))
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def update(path, mutate):
    data = load(path)
    mutate(data)
    save(path, data)
    return data


def _entry(key):
    if key not in CONFIG_KEYS:
        raise ValueError("Unknown config key: " + key + " (known: " + ", ".join(sorted(CONFIG_KEYS)) + ")")
    return CONFIG_KEYS[key]


def get_config(data, key):
    default = _entry(key)[1]
    node = data.get("config")
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


def set_config(data, key, raw):
    kind = _entry(key)[0]
    if kind is bool:
        lowered = str(raw).strip().lower()
        if lowered in _TRUE:
            value = True
        elif lowered in _FALSE:
            value = False
        else:
            raise ValueError("Invalid value for " + key + ": " + repr(raw) + " (allowed: " + ", ".join(_TRUE + _FALSE) + ")")
    else:
        value = kind(raw)
    node = data.setdefault("config", {})
    parts = key.split(".")
    for part in parts[:-1]:
        if not isinstance(node.get(part), dict):
            node[part] = {}
        node = node[part]
    node[parts[-1]] = value
    return data


def update_disabled(data, env=None):
    env = os.environ if env is None else env
    flag = env.get("BFF_NO_UPDATE_CHECK", "")
    if flag not in ("", "0"):
        return True
    return get_config(data, "update.check") is False
