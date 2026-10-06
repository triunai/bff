#!/usr/bin/env python3
"""Assert the shape of tests.yml and release.yml. Needs PyYAML; exits 2 without it, 1 on a failed check."""
import re
import sys

PINNED = re.compile(r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")
PIPE_TO_SHELL = re.compile(r"\|\s*(?:sh|bash|zsh|iex)\b")


def _common(workflow):
    problems = []
    if workflow.get("permissions") != {"contents": "read"}:
        problems.append("permissions must be exactly contents: read")
    for name, job in workflow.get("jobs", {}).items():
        for step in job.get("steps", []):
            uses = step.get("uses")
            if uses and not PINNED.match(uses):
                problems.append("%s: action not pinned to a full commit SHA: %s" % (name, uses))
            if PIPE_TO_SHELL.search(str(step.get("run", ""))):
                problems.append("%s: pipe-to-shell in a run step" % name)
    return problems


def check_release(workflow):
    problems = _common(workflow)
    jobs = workflow.get("jobs", {})
    if workflow.get(True, workflow.get("on")) != {"push": {"tags": ["v*"]}}:
        problems.append("release must trigger only on push of v* tags")
    for name in ("test", "privacy", "build", "attest", "draft"):
        if name not in jobs:
            problems.append("release job missing: " + name)
    for name, job in jobs.items():
        permissions = job.get("permissions") or {}
        if "id-token" in permissions and name != "attest":
            problems.append("id-token permission only allowed in attest, found in " + name)
        if permissions.get("contents") == "write" and name != "draft":
            problems.append("contents: write only allowed in draft, found in " + name)
        if "attestations" in permissions and name != "attest":
            problems.append("attestations permission only allowed in attest, found in " + name)
    if jobs.get("draft", {}).get("environment") != "release":
        problems.append("draft job must use environment: release")
    if (jobs.get("draft", {}).get("permissions") or {}).get("contents") != "write":
        problems.append("draft job must hold contents: write")
    attest = jobs.get("attest", {}).get("permissions") or {}
    if attest.get("id-token") != "write" or attest.get("attestations") != "write":
        problems.append("attest job must hold id-token and attestations: write")
    if jobs.get("privacy", {}).get("continue-on-error"):
        problems.append("privacy must be blocking in release")
    if set(jobs.get("build", {}).get("needs", [])) != {"test", "privacy"}:
        problems.append("build must need test and privacy")
    return problems


def check(workflow):
    problems = _common(workflow)
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
    return problems


def main(argv):
    if len(argv) < 2:
        print("usage: check_workflows.py WORKFLOW.yml [WORKFLOW.yml ...]", file=sys.stderr)
        return 2
    try:
        import yaml
    except ImportError:
        print("check_workflows: PyYAML is not installed", file=sys.stderr)
        return 2
    failed = False
    for path in argv[1:]:
        with open(path, encoding="utf-8") as handle:
            workflow = yaml.safe_load(handle)
        problems = (check_release if workflow.get("name") == "release" else check)(workflow)
        for problem in problems:
            print("FAIL: %s: %s" % (path, problem))
        print("workflow check %s: %s" % (path, "FAILED" if problems else "ok"))
        failed = failed or bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
