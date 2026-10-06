"""The once-a-day update notice that `bff osiris` shows (decision D6).

At most one check per 24 hours, recorded in the state file's `update_check` section (the Osiris banner
reads it). A one-key [Y/n] prompt appears only on a TTY; a non-TTY gets one line and stdin is never read.
Auto-update is opt-in (`update.auto`), applies only a VERIFIED update and requires attestation. Offline
is silent and nothing here may ever stop `bff osiris` from opening.

`bff.update` and `paths.install_prefix` are imported lazily; tests inject `latest`, `apply`, `relaunch`.
"""
import os
import re
import shutil
import sys
from datetime import datetime, timedelta, timezone

from . import paths, state
from .prompt import answer_is_yes

INTERVAL = timedelta(hours=24)
RELAUNCHED = "BFF_RELAUNCHED"
HINTS = {"dev": "git pull in your checkout", "uv": "uv tool upgrade bff", "brew": "brew upgrade bff"}
_STAMP = "%Y-%m-%dT%H:%M:%SZ"
_UNSET = object()


def _key(version):
    return tuple(int(part) for part in re.split(r"[-+]", version, 1)[0].split("."))


def _parse(stamp):
    try:
        return datetime.strptime(stamp, _STAMP).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _due(data, now):
    last = _parse((data.get("update_check") or {}).get("checked_at"))
    return last is None or now - last >= INTERVAL or last > now


def _record(state_file, now, current, latest, available, prompted_on=None):
    def mutate(data):
        old = data.get("update_check")
        kept = old.get("prompted_on") if isinstance(old, dict) else None
        data["update_check"] = {"checked_at": now.strftime(_STAMP), "current": current, "latest": latest,
                                "available": available, "prompted_on": prompted_on or kept}
    state.update(state_file, mutate)


def _mark_prompted(state_file, now):
    def mutate(data):
        data.setdefault("update_check", {})["prompted_on"] = now.strftime("%Y-%m-%d")
    state.update(state_file, mutate)


def relaunch_default():
    argv0 = shutil.which("bff") or os.path.abspath(sys.argv[0])
    env = dict(os.environ)
    env[RELAUNCHED] = "1"
    os.execve(argv0, [argv0] + sys.argv[1:], env)


def _method_hint():
    return HINTS.get(paths.install_method(), "reinstall bff from the release page")


def _report_success(result, out):
    if result.get("changes"):
        out.write(str(result["changes"]).rstrip() + "\n")
    out.write("undo: bff rollback\n")


def daily_notice(*, current, state_file, stdin, out, now=None, env=None, latest=None, apply=None,
                 relaunch=None, prefix=_UNSET, base=None):
    """Returns one outcome string; never raises."""
    try:
        return _notice(current, state_file, stdin, out, now, env, latest, apply, relaunch, prefix, base)
    except Exception as error:  # the notice must never stop bff osiris from opening
        out.write("update check failed: " + str(error) + "\n")
        return "unknown"


def _notice(current, state_file, stdin, out, now, env, latest, apply, relaunch, prefix, base):
    env = os.environ if env is None else env
    if env.get(RELAUNCHED):
        return "not-due"
    now = (now or datetime.now(timezone.utc)).replace(microsecond=0)
    data = state.load(state_file)
    if state.update_disabled(data, env):
        return "disabled"
    if not _due(data, now):
        return "not-due"
    if latest is None:
        from . import update
        base = base or update.release_base(env)
        found = update.latest_version(base)
    else:
        found = latest(base)
    available = bool(found) and _key(found) > _key(current)
    _record(state_file, now, current, found, available)
    if not found:
        return "unknown"
    if not available:
        return "no-update"
    if prefix is _UNSET:
        prefix = paths.install_prefix()
    if prefix is None:
        out.write("bff %s is available (you have %s). This install cannot self-update: %s\n"
                  % (found, current, _method_hint()))
        return "cannot-self-update"
    if apply is None:
        from . import update
        base = base or update.release_base(env)
        apply = update.apply_with_plugin
    if relaunch is None:
        relaunch = relaunch_default
    outcome = "noticed"
    if state.get_config(data, "update.auto") is True:
        try:
            result = apply(found, prefix=prefix, base=base, require_attestation=True)
        except ValueError as error:
            out.write("auto-update skipped: " + str(error) + "\n")
            outcome = "auto-failed"
        else:
            out.write("bff updated %s -> %s automatically.\n" % (current, found))
            _report_success(result, out)
            relaunch()
            return "auto-updated"
    if stdin.isatty():
        out.write("bff %s is available. Update now? [Y/n] " % found)
        out.flush()
        _mark_prompted(state_file, now)
        if answer_is_yes(stdin.readline()):
            try:
                result = apply(found, prefix=prefix, base=base)
            except ValueError as error:
                out.write("update failed, nothing changed: " + str(error) + "\n")
                return outcome
            _report_success(result, out)
            relaunch()
            return "updated"
        out.write("Skipped. Run bff update any time; turn this off with: bff config set update.check false\n")
        return outcome if outcome == "auto-failed" else "declined"
    out.write("bff %s is available (you have %s): run bff update\n" % (found, current))
    return outcome
