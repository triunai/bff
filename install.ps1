# bff on Windows = bff inside WSL2 (Ubuntu), because BB, which hosts Osiris, supports Windows only through WSL2
# (BB's README: "Windows via Ubuntu on WSL2"). Native activation needs slice S7 (a bff.cmd shim; install.py uses a
# symlink, which normal Windows accounts cannot create), so by default this script only checks WSL, prints the steps,
# and offers once to run the Linux installer inside WSL. NOT yet run on a real Windows machine.
# Run it as two steps (never piped):
#   Invoke-WebRequest https://github.com/triunai/bff/releases/latest/download/install.ps1 -OutFile install.ps1
#   Unblock-File .\install.ps1; .\install.ps1
param(
    [switch]$Setup,
    [string]$Prefix,
    [switch]$Yes,
    [switch]$NoModifyPath
)
$ErrorActionPreference = 'Stop'
$BffVersion = '0.1.1'
$BffRepo = 'triunai/bff'

# Native Windows cannot finish this install yet (see S7 above), so guide WSL2 before any download.
# BFF_WINDOWS_PREVIEW=1 lets a developer run the native rest of the script anyway.
if ($env:BFF_WINDOWS_PREVIEW -ne '1') {
    $bootstrap = 'cd ~ && curl -fsSLO https://raw.githubusercontent.com/' + $BffRepo + '/v' + $BffVersion + '/install.sh && sh install.sh --setup'
    Write-Host 'bff on Windows runs inside WSL2 (Ubuntu), like BB itself. Nothing was downloaded or changed.'
    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    $distros = @()
    if ($wsl) {
        # `wsl --list --quiet` prints UTF-16; strip the NULs PowerShell 5 leaves in each line.
        $distros = @(& wsl.exe --list --quiet 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
    }
    if ($distros.Count -eq 0) {
        Write-Host 'Step 1 (once, PowerShell as Administrator): wsl --install -d Ubuntu'
        Write-Host '        restart Windows, open "Ubuntu" from the Start menu and create your Linux user, then run this again.'
    } else {
        Write-Host ('Step 1: done. WSL2 has: ' + ($distros -join ', '))
    }
    Write-Host 'Step 2 (inside Ubuntu): sudo apt update && sudo apt install -y python3 git curl'
    Write-Host 'Step 3 (inside Ubuntu): install Node 22 or newer (https://nodejs.org), then start BB: npx bb-app@latest'
    Write-Host ('Step 4 (inside Ubuntu): ' + $bootstrap)
    Write-Host 'Step 5 (inside Ubuntu): bff osiris, then open http://localhost:38886 in your Windows browser. Stuck? bff osiris doctor'
    $interactive = $distros.Count -gt 0 -and -not $Yes -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    if ($interactive) {
        $answer = Read-Host 'Run step 4 inside WSL now? [Y/n]'
        # Read-Host returns $null at end of input: EOF is never consent.
        if ($null -ne $answer -and ($answer -eq '' -or $answer -match '^(y|yes)$')) {
            & wsl.exe -- sh -c $bootstrap
            exit $LASTEXITCODE
        }
    }
    exit 3
}

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

$releases = if ($env:BFF_RELEASE_BASE) { $env:BFF_RELEASE_BASE } else { "https://github.com/$BffRepo/releases" }
if ($releases -notmatch '^https://') { throw 'BFF_RELEASE_BASE must start with https://.' }
if ($env:BFF_RELEASE_BASE) { Write-Host "release source: $releases" }
$base = "$releases/download/v$BffVersion"

$stage = Join-Path ([IO.Path]::GetTempPath()) ('bff-download-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $tarball = Join-Path $stage 'release.tar.gz'
    $sums = Join-Path $stage 'SHA256SUMS'
    Invoke-WebRequest -Uri "$base/bff-$BffVersion.tar.gz" -OutFile $tarball -UseBasicParsing
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing

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
