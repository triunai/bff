# Native Windows (PowerShell 5.1 and 7, no admin): install.py stages the release under %LOCALAPPDATA%\bff and
# activates it by writing a bff.cmd shim into %LOCALAPPDATA%\bff\bin (no symlink, which normal accounts cannot make).
# The shim logic is covered by pure-function tests that simulate Windows; this script has not yet run on real Windows.
# One-liner (private repo; needs the GitHub CLI and `gh auth login`; no pipe into iex, the script runs as a scriptblock):
#   & ([scriptblock]::Create((gh release download --repo triunai/bff --pattern install.ps1 -O - | Out-String))) -Setup
# Offline / CI source: BFF_RELEASE_DIR=<dir holding bff-X.Y.Z.tar.gz and SHA256SUMS> skips gh; the SHA256 check is unchanged.
# BFF_RESULT_FILE=<file> also writes install.py's JSON result there.
param(
    [switch]$Setup,
    [string]$Prefix,
    [switch]$Yes,
    [switch]$NoModifyPath
)
$ErrorActionPreference = 'Stop'
$BffVersion = '0.2.0'
$BffRepo = 'triunai/bff'
if (-not $Prefix -and $env:BFF_PREFIX) { $Prefix = $env:BFF_PREFIX }   # same as -Prefix

Write-Host 'Native Windows install: this path is new and has not been run on a real Windows machine yet. If it fails, the message says why; WSL with install.sh is the fallback.'
$pythonHelp = "BFF needs Python 3.9 or newer. Install it, then run this installer again:`n  winget install --id=astral-sh.uv -e`n  winget install Python.Python.3.12"

# One argument, quoted for CreateProcess (spaces, quotes, trailing backslashes).
function ConvertTo-ArgString {
    param([string[]]$Items)
    $parts = @()
    foreach ($item in $Items) {
        $a = [string]$item
        if ($a -eq '') { $parts += '""' }
        elseif ($a -notmatch '[\s"]') { $parts += $a }
        else { $parts += ('"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"') }
    }
    return ($parts -join ' ')
}

# Runs a program with stdout and stderr captured SEPARATELY (no ErrorRecord wrapping, so 'Stop' cannot trip on
# stderr text and install.py's JSON stays clean). Returns Code, Out, Err. TimeoutSec 0 means wait forever.
function Invoke-Captured {
    param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSec = 0)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = ConvertTo-ArgString $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['PYTHONUTF8'] = '1'
    $proc = [System.Diagnostics.Process]::Start($psi)
    try {
        $proc.StandardInput.Close()
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        $waitMs = -1
        if ($TimeoutSec -gt 0) { $waitMs = $TimeoutSec * 1000 }
        if (-not $proc.WaitForExit($waitMs)) {
            try { $proc.Kill() } catch { }
            return [pscustomobject]@{ Code = 124; Out = ''; Err = "timed out after $TimeoutSec seconds: $Exe" }
        }
        $proc.WaitForExit()
        return [pscustomobject]@{ Code = $proc.ExitCode; Out = [string]$outTask.Result; Err = [string]$errTask.Result }
    } finally {
        $proc.Dispose()
    }
}

# A usable Python is one that RUNS and is 3.9+. The Microsoft Store alias stub is a zero-byte file that exits
# non-zero when given arguments, so it fails this probe; a real Store or winget Python passes it.
function Find-Python {
    foreach ($candidate in @(@('py', '-3'), @('python'), @('python3'))) {
        $extra = @($candidate | Select-Object -Skip 1)
        $found = @(Get-Command $candidate[0] -CommandType Application -All -ErrorAction SilentlyContinue)
        foreach ($app in $found) {
            $probe = $null
            try { $probe = Invoke-Captured $app.Source ($extra + @('-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 3)')) 60 } catch { continue }
            if ($probe.Code -eq 0) { return @($app.Source) + $extra }
        }
    }
    throw $pythonHelp
}

# Interactive means a person can answer. When run from a web one-liner stdin is usually the console, so also honour CI markers,
# a hidden console and -NonInteractive; Read-Host is wrapped anyway.
function Test-Interactive {
    if ($env:CI -or $env:GITHUB_ACTIONS -or $env:TF_BUILD) { return $false }
    if (-not [Environment]::UserInteractive) { return $false }
    try { if ([Console]::IsInputRedirected) { return $false } } catch { return $false }
    foreach ($arg in [Environment]::GetCommandLineArgs()) { if ($arg -imatch '^[-/]noni') { return $false } }
    return $true
}



$python = @(Find-Python)
$pythonExe = $python[0]
$pythonArgs = @($python | Select-Object -Skip 1)
$base = $null
$gh = $null
$releaseDir = $env:BFF_RELEASE_DIR
if ($releaseDir) {
    # Local release folder (CI, offline): no network and no login; verification below is identical.
    if (-not (Test-Path -LiteralPath $releaseDir -PathType Container)) { throw "BFF_RELEASE_DIR is not a folder: $releaseDir" }
} elseif ($env:BFF_RELEASE_BASE) {
    # Explicit release source (mirror): plain download, no GitHub login needed.
    if ($env:BFF_RELEASE_BASE -notmatch '^https://') { throw 'BFF_RELEASE_BASE must start with https://.' }
    Write-Host "release source: $($env:BFF_RELEASE_BASE)"
    $base = "$($env:BFF_RELEASE_BASE)/download/v$BffVersion"
} else {
    # Default source: the private GitHub repo, through the GitHub CLI (it owns the login).
    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gh) {
        throw ("BFF is a private repository, so the installer needs the GitHub CLI (gh). Install it, then run: gh auth login`n" +
            "  winget install --id GitHub.cli -e   (or https://cli.github.com)")
    }
    $auth = Invoke-Captured $gh.Source @('auth', 'status') 60
    if ($auth.Code -ne 0) { throw "The GitHub CLI is not signed in. Run: gh auth login   (the account needs read access to $BffRepo), then run this installer again." }
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ('bff-download-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $tarball = Join-Path $stage 'release.tar.gz'
    $sums = Join-Path $stage 'SHA256SUMS'
    if ($releaseDir) {
        $localArchive = Join-Path $releaseDir "bff-$BffVersion.tar.gz"
        $localSums = Join-Path $releaseDir 'SHA256SUMS'
        if (-not (Test-Path -LiteralPath $localArchive -PathType Leaf)) { throw "BFF_RELEASE_DIR has no bff-$BffVersion.tar.gz." }
        if (-not (Test-Path -LiteralPath $localSums -PathType Leaf)) { throw 'BFF_RELEASE_DIR has no SHA256SUMS file; refusing to install an unverified archive.' }
        Copy-Item -LiteralPath $localArchive -Destination $tarball
        Copy-Item -LiteralPath $localSums -Destination $sums
        Write-Host "release source: $releaseDir"
    } elseif ($base) {
        Invoke-WebRequest -Uri "$base/bff-$BffVersion.tar.gz" -OutFile $tarball -UseBasicParsing
        Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
    } else {
        $dl = Invoke-Captured $gh.Source @('release', 'download', "v$BffVersion", '--repo', $BffRepo, '--pattern', "bff-$BffVersion.tar.gz", '--pattern', 'SHA256SUMS', '--dir', $stage, '--clobber')
        if ($dl.Code -ne 0) {
            if ($dl.Err) { Write-Host $dl.Err.Trim() }
            throw "BFF download failed. Check that this gh account can read $BffRepo and that release v$BffVersion is published, then run this installer again."
        }
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
    $ex = Invoke-Captured $pythonExe ($pythonArgs + @($extractFile, $stage, $BffVersion))
    if ($ex.Code -ne 0) {
        if ($ex.Err) { Write-Host $ex.Err.Trim() }
        throw 'BFF archive verification failed; installation stopped. The reason is printed above this line; run this installer again, or download the release by hand from https://github.com/triunai/bff/releases.'
    }

    $installer = Join-Path $stage "bff-$BffVersion\install.py"
    $installArgs = @($installer)
    if ($Prefix) { $installArgs += @('--prefix', $Prefix) }
    $installArgs += '--no-modify-path'
    $run = Invoke-Captured $pythonExe ($pythonArgs + $installArgs)
    if ($run.Err) { Write-Host $run.Err.Trim() }
    if ($run.Code -ne 0) { throw 'BFF install failed; the reason is printed above this line. Fix it, then run this installer again.' }
    $json = $run.Out.Trim()
    $result = $null
    try { $result = $json | ConvertFrom-Json } catch { throw 'BFF install printed something that is not JSON; run this installer again.' }
    $command = $result.command
    if (-not $command) { throw 'Could not find the bff command after installing. Run this installer again.' }
    Write-Output $json
    if ($env:BFF_RESULT_FILE) { Set-Content -Path $env:BFF_RESULT_FILE -Value $json -Encoding ASCII }
    $binDir = Split-Path -Parent $command

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $onPath = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $binDir.TrimEnd('\')) }).Count -gt 0
    if (-not $onPath) {
        $answer = $null
        if ((Test-Interactive) -and -not $Yes -and -not $NoModifyPath) {
            try { $answer = Read-Host "Add $binDir to your user PATH? [Y/n]" } catch { $answer = $null }
        }
        if ($null -ne $answer) {
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
        $saved = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & $command @setupArgs } finally { $ErrorActionPreference = $saved }
        $code = $LASTEXITCODE
        if ($code -eq 3) { Write-Host 'bff is installed; Osiris setup is waiting on the prerequisites listed above. Install them, then run: bff osiris setup' }
        if ($code -eq 4) { Write-Host 'bff is installed. Osiris is not publicly released yet, so there is nothing more to set up.' }
        if ($code -ne 0 -and $code -ne 3 -and $code -ne 4) { throw "bff osiris setup exited with code $code (bff itself is installed)." }
    }
} finally {
    Remove-Item -Recurse -Force -Path $stage -ErrorAction SilentlyContinue
}
