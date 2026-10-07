# Native Windows (PowerShell 5.1 and 7, no admin): install.py stages the release under %LOCALAPPDATA%\bff and
# activates it by writing a bff.cmd shim into %LOCALAPPDATA%\bff\bin (no symlink, which normal accounts cannot make).
# The shim logic is covered by pure-function tests that simulate Windows; this script has not yet run on real Windows.
# One-liner (private repo; needs the GitHub CLI and `gh auth login`; no pipe into iex, the script runs as a scriptblock):
#   & ([scriptblock]::Create((gh release download --repo triunai/bff --pattern install.ps1 -O - | Out-String))) -Setup
param(
    [switch]$Setup,
    [string]$Prefix,
    [switch]$Yes,
    [switch]$NoModifyPath
)
$ErrorActionPreference = 'Stop'
$BffVersion = '0.1.1'
$BffRepo = 'triunai/bff'

Write-Host 'Native Windows install: this path is new and has not been run on a real Windows machine yet. If it fails, the message says why; WSL with install.sh is the fallback.'

function Find-Python {
    $candidates = @(@('py', '-3'), @('python'))
    foreach ($candidate in $candidates) {
        $found = Get-Command $candidate[0] -ErrorAction SilentlyContinue
        if (-not $found) { continue }
        if ($found.Source -match '\\WindowsApps\\') {
            Write-Error ("Refusing the Microsoft Store Python stub at " + $found.Source + ". Install a real Python, then run this installer again:`n" +
                "  winget install --id=astral-sh.uv -e`n  winget install Python.Python.3.12")
        }
        return @($found.Source) + @($candidate | Select-Object -Skip 1)
    }
    Write-Error ("BFF needs Python 3.9 or newer. Install it, then run this installer again:`n" +
        "  winget install --id=astral-sh.uv -e`n  winget install Python.Python.3.12")
}

$python = @(Find-Python)
$pythonExe = $python[0]
$pythonArgs = @($python | Select-Object -Skip 1)
& $pythonExe @pythonArgs -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"
if ($LASTEXITCODE -ne 0) { throw ("BFF needs Python 3.9 or newer. Install it, then run this installer again:`n" +
    "  winget install --id=astral-sh.uv -e`n  winget install Python.Python.3.12") }

$base = $null
if ($env:BFF_RELEASE_BASE) {
    # Explicit release source (mirror): plain download, no GitHub login needed.
    if ($env:BFF_RELEASE_BASE -notmatch '^https://') { throw 'BFF_RELEASE_BASE must start with https://.' }
    Write-Host "release source: $($env:BFF_RELEASE_BASE)"
    $base = "$($env:BFF_RELEASE_BASE)/download/v$BffVersion"
} else {
    # Default source: the private GitHub repo, through the GitHub CLI (it owns the login).
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw ("BFF is a private repository, so the installer needs the GitHub CLI (gh). Install it, then run: gh auth login`n" +
            "  winget install --id GitHub.cli -e   (or https://cli.github.com)")
    }
    & gh auth status *> $null
    if ($LASTEXITCODE -ne 0) { throw "The GitHub CLI is not signed in. Run: gh auth login   (the account needs read access to $BffRepo), then run this installer again." }
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ('bff-download-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $tarball = Join-Path $stage 'release.tar.gz'
    $sums = Join-Path $stage 'SHA256SUMS'
    if ($base) {
        Invoke-WebRequest -Uri "$base/bff-$BffVersion.tar.gz" -OutFile $tarball -UseBasicParsing
        Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
    } else {
        & gh release download "v$BffVersion" --repo $BffRepo --pattern "bff-$BffVersion.tar.gz" --pattern SHA256SUMS --dir $stage --clobber
        if ($LASTEXITCODE -ne 0) { throw "BFF download failed. Check that this gh account can read $BffRepo and that release v$BffVersion is published, then run this installer again." }
        Move-Item -Force -Path (Join-Path $stage "bff-$BffVersion.tar.gz") -Destination $tarball
    }

    $wanted = 'bff-' + $BffVersion + '.tar.gz'
    $rows = @(Get-Content $sums | Where-Object { $_.Trim() } | ForEach-Object { , ($_.Trim() -split '\s+') } |
        Where-Object { $_.Count -eq 2 -and $_[1] -eq $wanted })
    if ($rows.Count -ne 1) { throw 'BFF archive checksum mismatch; installation stopped. Run the installer again; if it keeps failing, download it by hand from https://github.com/triunai/bff/releases.' }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tarball).Hash.ToLower()
    if ($actual -ne $rows[0][0].ToLower()) { throw 'BFF archive checksum mismatch; installation stopped. Run the installer again; if it keeps failing, download it by hand from https://github.com/triunai/bff/releases.' }

    # Same entry checks and extraction program as install.sh (tests keep the two texts identical).
    $extract = @'
import hashlib, pathlib, sys, tarfile
stage, version = pathlib.Path(sys.argv[1]), sys.argv[2]
archive = stage / 'release.tar.gz'
rows = [r.split() for r in (stage / 'SHA256SUMS').read_text().splitlines() if r.strip()]
expected = [r[0] for r in rows if len(r) == 2 and r[1] == 'bff-' + version + '.tar.gz']
if len(expected) != 1 or hashlib.sha256(archive.read_bytes()).hexdigest() != expected[0]:
    raise SystemExit('BFF archive checksum mismatch; installation stopped. Run the installer again; if it keeps failing, download it by hand from https://github.com/triunai/bff/releases.')
root = 'bff-' + version
with tarfile.open(archive, 'r:gz') as tf:
    members = tf.getmembers()
    if len(members) > 5000 or sum(m.size for m in members) > 100 * 1024 * 1024:
        raise SystemExit('BFF archive exceeds bounded release limits. This should not happen with an official release; download it by hand from https://github.com/triunai/bff/releases.')
    seen = set()
    for m in members:
        path = pathlib.PurePosixPath(m.name)
        if (path.is_absolute() or '..' in path.parts or not path.parts or
                path.parts[0] != root or not (m.isfile() or m.isdir()) or
                m.name != path.as_posix() or path.as_posix() in seen):
            raise SystemExit('BFF archive contains an unsafe entry. This should not happen with an official release; download it by hand from https://github.com/triunai/bff/releases.')
        seen.add(path.as_posix())
    for m in members:
        target = stage / m.name
        if m.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tf.extractfile(m).read())
            target.chmod(0o755 if m.name.endswith('/install.sh') else 0o644)

'@
    $extractFile = Join-Path $stage 'extract.py'
    Set-Content -Path $extractFile -Value $extract -Encoding ASCII
    & $pythonExe @pythonArgs $extractFile $stage $BffVersion
    if ($LASTEXITCODE -ne 0) { throw 'BFF archive verification failed; installation stopped. The reason is printed above this line; run this installer again, or download the release by hand from https://github.com/triunai/bff/releases.' }

    $installer = Join-Path $stage "bff-$BffVersion\install.py"
    $installArgs = @()
    if ($Prefix) { $installArgs += @('--prefix', $Prefix) }
    $installArgs += '--no-modify-path'
    $output = & $pythonExe @pythonArgs $installer @installArgs
    if ($LASTEXITCODE -ne 0) { throw 'BFF install failed; the reason is printed above this line. Fix it, then run this installer again.' }
    $output | ForEach-Object { Write-Host $_ }
    $result = ($output -join "`n") | ConvertFrom-Json
    $command = $result.command
    $binDir = Split-Path -Parent $command

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $onPath = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $binDir.TrimEnd('\')) }).Count -gt 0
    if (-not $onPath) {
        $interactive = -not $Yes -and -not $NoModifyPath -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
        if ($interactive) {
            $answer = Read-Host "Add $binDir to your user PATH? [Y/n]"
            if ($answer -eq '' -or $answer -match '^(y|yes)$') {
                $new = if ($userPath) { $userPath.TrimEnd(';') + ';' + $binDir } else { $binDir }
                [Environment]::SetEnvironmentVariable('Path', $new, 'User')
                Write-Host 'Added to your user PATH. Open a new terminal to pick it up.'
            } else {
                Write-Host "Add $binDir to your user PATH to run bff by name."
            }
        } else {
            Write-Host "Add $binDir to your user PATH to run bff by name (not edited: -Yes, -NoModifyPath or no console)."
        }
    }

    if ($Setup) {
        $setupArgs = @('osiris', 'setup')
        if ($Yes) { $setupArgs += '--yes' }
        & $command @setupArgs
        $code = $LASTEXITCODE
        if ($code -eq 3) { Write-Host 'bff is installed; Osiris setup is waiting on the prerequisites listed above. Install them, then run: bff osiris setup' }
        if ($code -eq 4) { Write-Host 'bff is installed. Osiris is not publicly released yet, so there is nothing more to set up.' }
        exit $code
    }
} finally {
    Remove-Item -Recurse -Force -Path $stage -ErrorAction SilentlyContinue
}
