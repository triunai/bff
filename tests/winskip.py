"""Skips for tests whose FIXTURE is POSIX-only, never for product behaviour.

A fixture is POSIX-only when it builds a shell-script program, depends on file modes, uids or symlinks that a normal Windows account cannot create,
or runs install.sh. The Windows rule for the same code path has its own test (the *_windows.py files, which run on every OS) and the real-Windows
smoke job (.github/workflows/windows.yml) exercises the installed product end to end. A test is skipped here only with the reason it cannot run.
"""
import sys
import unittest

WINDOWS = sys.platform.startswith("win")


def posix_only(reason):
    return unittest.skipIf(WINDOWS, "POSIX-only fixture: " + reason)
