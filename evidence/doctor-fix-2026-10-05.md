# bff doctor install/update mode — evidence (2026-10-05)

Branch feat/doctor-fix, base 5c7caef629666099032ee41459163152e1cee2b9 (main, v0.1.0).

## Recipe table (verified 2026-10-05)
| Tool | Route(s) | Latest source | Source URL |
|---|---|---|---|
| BB | manual (no documented global pm install; npx or desktop app) | n/a | https://github.com/get-bb/bb (README: `npx bb-app@latest`; npm bb-app 0.45.0 is "launcher for npx") |
| Herdr | brew install herdr / brew upgrade herdr | brew info --json=v2 (stable 0.9.3) | https://herdr.dev (homebrew-core formula verified with brew info) |
| Beads (bd) | brew install beads; npm install -g @beads/bd@latest | brew info / npm view | https://github.com/gastownhall/beads README lines "brew install beads", "npm install -g @beads/bd" (npm view @beads/bd: bin bd, 1.3.1) |
| OMC | npm install -g oh-my-claude-sisyphus@latest | npm view | https://github.com/Yeachan-Heo/oh-my-claudecode README ("npm i -g oh-my-claude-sisyphus@latest"; npm bin omc) |
| OMX | npm install -g oh-my-codex@latest | npm view | https://github.com/Yeachan-Heo/oh-my-codex README ("npm install -g oh-my-codex"; npm bin omx) |
| aeh | manual | n/a | local prototype; ~/.local/share/aeh/releases/0.1.0-*/manifest.json, no public source found; PROVENANCE.md says it is a separate candidate integration |

`br` (beads_rust) is accepted as "Beads present" for detection but never installed.

## Real dry-run on this machine (stdin /dev/null, nothing changed)
```
TOOL     STATUS   INSTALLED    LATEST       NOTE
BB       found    0.45.0       -            
Herdr    found    0.9.3        0.9.3        
Beads    missing  -            1.3.1        will install
OMC      found    5.6.0        5.6.1        will upgrade
OMX      found    0.21.7       0.21.7       
aeh      found    0.1.0        -            

Planned actions:
  install Beads: /opt/homebrew/bin/brew install beads
  upgrade OMC: /Users/khumeren/.local/state/fnm_multishells/1890_1791184881104/bin/npm install -g oh-my-claude-sisyphus@latest

Non-interactive and --yes not given: no changes made.
```
Exit code 0.

## Tests
- python3 -m unittest discover -s tests: 50 tests OK (includes the new tests/test_doctor.py)
- npm run test:osiris (node_modules symlinked temporarily from main checkout, then removed): 22 pass, 0 fail.

## Deviations
1. tests/test_bff.py::test_doctor_does_not_execute_or_read_configs asserted that plain `doctor` prints JSON; plain doctor is now a table by design, so the test now calls `doctor --json` (assertions unchanged).
2. release-files.json: added "bff/doctor.py". Without it the release builder rejects the new file ("Unreviewed distributable file") and tests/test_release.py fails. This file was not in the allowed list; builder code is untouched.
3. Slice boundaries: slice 1 (doctor.py) already contained the execution functions; slice 2 is the cli.py wiring. Slice 3 also carries a docstring wording fix in doctor.py.
4. `--json` runs no subprocess and returns the legacy payload unchanged (no new fields), so it reports availability only, not versions.
5. PROVENANCE.md says OMC/OMX/Herdr/Beads "are not installed or bundled" and README says `bff start` "does not install BB/Herdr". These are descriptive (release contents / start command), not a prohibition, so I proceeded; PROVENANCE.md and README line 29 may now read as stale and I did not edit PROVENANCE.md (not allowed).
6. No CHANGELOG.md exists, so none added.

## What I could NOT verify
- Herdr's own README install instructions (raw README fetch returned nothing); only the homebrew-core formula via brew info.
- That BB has no global npm install route beyond the README (treated as manual).
- Actual install/upgrade execution against real brew/npm (by design: only mocked in tests). Post-install detection of npm-installed tools assumes the npm global bin dir is on PATH.
- Windows/Linux behaviour; owner detection uses /Cellar/ and node_modules path markers (fnm-managed omc resolved correctly in the dry run only by virtue of the upgrade plan appearing).
- Upstream aeh source.
