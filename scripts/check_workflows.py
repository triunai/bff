#!/usr/bin/env python3
"""Assert the shape of .github/workflows/tests.yml. Needs PyYAML; exits 2 without it, 1 on a failed check."""
import re
import sys

PINNED = re.compile(r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")


def check(workflow):
    problems = []
    if workflow.get("permissions") != {"contents": "read"}:
        problems.append("permissions must be exactly contents: read")
    jobs = workflow.get("jobs", {})
    matrix = jobs.get("python", {}).get("strategy", {}).get("matrix", {})
    if matrix.get("os") != ["ubuntu-latest", "macos-latest", "windows-latest"]:
        problems.append("python job matrix.os must be ubuntu, macos, windows")
    if matrix.get("python-version") != ["3.9", "3.12"]:
        problems.append("python job matrix.python-version must be 3.9 and 3.12")
    if "windows-latest" not in str(jobs.get("python", {}).get("continue-on-error", "")):
        problems.append("windows must be continue-on-error")
    privacy = jobs.get("privacy", {})
    if privacy.get("continue-on-error") is not True:
        problems.append("privacy job must exist with continue-on-error: true")
    if not any("privacy_gate.py" in str(s.get("run", "")) for s in privacy.get("steps", [])):
        problems.append("privacy job must run scripts/privacy_gate.py")
    for name, job in jobs.items():
        for step in job.get("steps", []):
            uses = step.get("uses")
            if uses and not PINNED.match(uses):
                problems.append("%s: action not pinned to a full commit SHA: %s" % (name, uses))
    return problems


def main(argv):
    if len(argv) != 2:
        print("usage: check_workflows.py WORKFLOW.yml", file=sys.stderr)
        return 2
    try:
        import yaml
    except ImportError:
        print("check_workflows: PyYAML is not installed", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as handle:
        problems = check(yaml.safe_load(handle))
    for problem in problems:
        print("FAIL: " + problem)
    print("workflow check: " + ("FAILED" if problems else "ok"))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
