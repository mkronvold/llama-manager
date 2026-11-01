#Requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$Yes,
    [ValidateSet('Ask', 'Install', 'Skip')]
    [string]$Winget = 'Ask',
    [ValidateSet('Ask', 'Install', 'Skip')]
    [string]$UpdateClone = 'Ask',
    [ValidatePattern('^22\.\d+\.\d+$')]
    [string]$NodeVersion = '22.23.2',
    [ValidateSet('Ask', 'Install', 'Skip')]
    [string]$Strata = 'Ask',
    [ValidateSet('Ask', 'Install', 'Skip')]
    [string]$Shortcut = 'Ask',
    [string]$StrataDirectory,
    [ValidateSet('auto', 'cuda', 'hip')]
    [string]$StrataBackend = 'auto',
    [ValidateRange(1024, 32768)]
    [int]$StrataContext = 32768,
    [string]$StrataConfig
)

$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed (exit $LASTEXITCODE). Resolve the error above and rerun setup."
    }
}

function Confirm-SetupChoice {
    param([string]$Choice, [string]$Message, [bool]$Unattended)
    if ($Choice -eq 'Install') { return $true }
    if ($Choice -eq 'Skip' -or $Unattended) { return $false }
    while ($true) {
        $answer = (Read-Host "$Message [y/N]").Trim()
        if ($answer -eq '' -or $answer -match '^(n|no)$') { return $false }
        if ($answer -match '^(y|yes)$') { return $true }
        Write-Host 'Enter yes or no.'
    }
}

function Update-SetupPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
        [Environment]::GetEnvironmentVariable('Path', 'User')
    foreach ($name in 'NVM_HOME', 'NVM_SYMLINK') {
        $value = [Environment]::GetEnvironmentVariable($name, 'User')
        if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, 'Machine') }
        if ($value) {
            Set-Item "Env:$name" $value
            $env:Path = "$value;$env:Path"
        }
    }
}

function Install-SetupPackage {
    param([string]$Id)
    Invoke-Checked 'winget.exe' @('install', '--id', $Id, '--exact', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    Update-SetupPath
}

function Assert-ManagerClosed {
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'llama-manager|(?:tsx|node).*[\\/]src[\\/]main\.ts' }
    if ($running) {
        throw 'Close llama-manager before setup so it cannot overwrite the profile configuration.'
    }
}

function Ensure-SetupWinget {
    param([string]$Choice, [bool]$Unattended)
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) { return }
    $help = 'Install/update App Installer: https://apps.microsoft.com/detail/9nblggh4nns1 . Reopen PowerShell and rerun setup.'
    if (-not (Confirm-SetupChoice $Choice 'Install/repair winget using Microsoft.WinGet.Client from PowerShell Gallery?' $Unattended)) {
        throw "winget is required. $help"
    }
    try {
        # Microsoft's documented bootstrap; current-user scope avoids changing other users' modules.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Install-PackageProvider -Name NuGet -Scope CurrentUser -Force | Out-Null
        Install-Module -Name Microsoft.WinGet.Client -Scope CurrentUser -Force -Repository PSGallery
        Import-Module Microsoft.WinGet.Client
        Repair-WinGetPackageManager
        Update-SetupPath
    } catch {
        throw "winget bootstrap failed: $($_.Exception.Message). If elevation is required, rerun under the same account with elevation. $help"
    }
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw $help }
    Invoke-Checked 'winget.exe' @('--version')
}

function Update-SetupClone {
    param([string]$Repo, [string]$Choice, [bool]$Unattended)
    if (-not (Test-Path -LiteralPath (Join-Path $Repo '.git'))) {
        Write-Host 'No Git metadata (ZIP installation); download a fresh branch ZIP to update.'
        return
    }
    $tracking = & git.exe -C $Repo rev-parse --abbrev-ref '@{upstream}' 2>$null
    if ($LASTEXITCODE) {
        Write-Warning 'No tracking branch; configure one yourself before requesting an update.'
        if ($Choice -eq 'Install') { throw 'Cannot update without a tracking branch.' }
        return
    }
    Invoke-Checked 'git.exe' @('-C', $Repo, 'fetch')
    $counts = (& git.exe -C $Repo rev-list --left-right --count 'HEAD...@{upstream}').Trim() -split '\s+'
    if ($LASTEXITCODE) { throw 'Could not compare clone with its tracking branch.' }
    if ([int]$counts[1] -eq 0) {
        Write-Host "Clone has no incoming commits ($($counts[0]) local-only commits)."
        return
    }
    if (-not (Confirm-SetupChoice $Choice "Clone is behind $tracking by $($counts[1]) commits. Update?" $Unattended)) {
        Write-Warning 'Continuing with the current clone; incoming updates were not applied.'
        return
    }
    if ([int]$counts[0] -gt 0) { throw 'Clone has diverged; reconcile it manually. Setup never resets or rebases.' }
    $dirty = & git.exe -C $Repo status --porcelain
    if ($LASTEXITCODE) { throw 'Could not check worktree safety.' }
    if ($dirty) { throw 'Worktree is not clean (including untracked files). Commit/move your changes and rerun; nothing was stashed or reset.' }
    Invoke-Checked 'git.exe' @('-C', $Repo, 'pull', '--ff-only')
    throw 'Clone updated successfully. Rerun setup to use the updated script; no further installation was performed in this run.'
}

function Test-SetupNvidia {
    param([string]$Backend)
    if ($Backend -eq 'hip') { return }
    $cards = @(Get-CimInstance Win32_VideoController)
    $hasNvidia = @($cards | Where-Object { $_.Name -match 'NVIDIA' }).Count -gt 0
    if (-not $hasNvidia -and $Backend -eq 'auto') {
        Write-Host 'No NVIDIA adapter detected; Strata Check will determine supported hardware.'
        return
    }
    $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if (-not $smi) {
        $candidate = Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'
        if (Test-Path -LiteralPath $candidate) { $smi = Get-Item -LiteralPath $candidate }
    }
    $help = 'Install/update the driver through NVIDIA App or https://www.nvidia.com/drivers/ . Reboot if requested, then verify nvidia-smi and rerun setup. Drivers are not installed by this script.'
    if (-not $smi) { throw "nvidia-smi is missing. $help" }
    $executable = if ($smi -is [IO.FileInfo]) { $smi.FullName } else { $smi.Source }
    try { Invoke-Checked $executable @('--query-gpu=name,memory.total,driver_version', '--format=csv') }
    catch { throw "NVIDIA diagnostics failed: $($_.Exception.Message). $help" }
}

function Write-SetupNextSteps {
    param([bool]$HasStrata)
    Write-Host 'Launch: run llama-manager, or open the generated Llama Manager shortcut.'
    if ($HasStrata) {
        Write-Host 'Profiles (5): select strata. Dashboard (1): Start; wait for the model to load.'
        Write-Host 'Verify: Invoke-RestMethod http://127.0.0.1:1234/v1/status (loaded should be true).'
        Write-Host 'Existing strata profiles are preserved; check their binding and endpoint before starting.'
    } else {
        Write-Host 'Versions (6): Install a runtime, e.g. llama.cpp Windows x64 CUDA for NVIDIA.'
        Write-Host 'Models (7): download/select a fitting GGUF, e.g. a small Qwen instruct Q4_K_M.'
        Write-Host 'Profiles (5): configure it. Dashboard (1): Start.'
    }
    Write-Host 'No model was started. Keep localhost-only; set an API key before enabling network access.'
}

if ($MyInvocation.InvocationName -eq '.') { return }
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows.' }
if ([version]$NodeVersion -lt [version]'22.12.0') { throw 'Use Node 22.12.0 or newer in the 22.x series.' }

$repo = Split-Path -Parent $PSScriptRoot
if (-not $StrataDirectory) {
    $StrataDirectory = Join-Path (Split-Path -Parent $repo) 'Strata'
}
$StrataDirectory = [IO.Path]::GetFullPath($StrataDirectory)
Assert-ManagerClosed

Write-Host 'Setup installs missing Git, nvm-windows, Node 22 (including npm), and Windows Terminal.'
Write-Host 'It builds and links this clone. Installers may request elevation; no drivers are installed.'
if (-not $Yes -and -not (Confirm-SetupChoice 'Ask' 'Continue with prerequisite installation?' $false)) {
    Write-Host 'Cancelled; nothing installed.'
    return
}
Ensure-SetupWinget $Winget ([bool]$Yes)

$nvm = Get-Command nvm.exe -ErrorAction SilentlyContinue
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node -and -not $nvm) {
    throw 'Standalone Node is already installed. Uninstall it yourself before installing nvm-windows, then reopen PowerShell. Setup will not remove it.'
}
if (-not $nvm) { Install-SetupPackage 'CoreyButler.NVMforWindows' }
if (-not (Get-Command nvm.exe -ErrorAction SilentlyContinue)) {
    throw 'nvm was installed but is not on PATH. Open a new PowerShell window and rerun setup.'
}
Invoke-Checked 'nvm.exe' @('install', $NodeVersion)
Invoke-Checked 'nvm.exe' @('use', $NodeVersion)
Update-SetupPath
$actual = (& node.exe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -ne "v$NodeVersion") {
    throw "Expected Node v$NodeVersion, got $actual. Resolve PATH/nvm symlink conflicts and rerun; nvm use may require elevation."
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm is missing from the activated Node installation.' }
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Install-SetupPackage 'Git.Git' }
if (-not (Get-Command wt.exe -ErrorAction SilentlyContinue)) { Install-SetupPackage 'Microsoft.WindowsTerminal' }
Invoke-Checked 'npm.cmd' @('--version')
Invoke-Checked 'git.exe' @('--version')
if (-not (Get-Command wt.exe -ErrorAction SilentlyContinue)) { throw 'Windows Terminal is still unavailable. Reopen PowerShell after installation and rerun.' }
Update-SetupClone $repo $UpdateClone ([bool]$Yes)

Push-Location $repo
try {
    # npm ci runs prepare (the build) and restores the exact locked dependencies.
    try {
        Invoke-Checked 'npm.cmd' @('ci')
    } catch {
        Write-Warning 'If better-sqlite3 failed to compile, install Python and Visual Studio Build Tools (Desktop development with C++), then rerun.'
        throw
    }
    Invoke-Checked 'node.exe' @('-e', "const D=require('better-sqlite3');const d=new D(':memory:');d.prepare('select 1').get();d.close();console.log('SQLite native module ready')")
    Invoke-Checked 'npm.cmd' @('run', 'lint')
    Invoke-Checked 'npm.cmd' @('link')

    $wantStrata = Confirm-SetupChoice $Strata 'Install/configure Strata? Expect a large model download (roughly 70-120 GB).' ([bool]$Yes)
    if ($wantStrata) {
        Assert-ManagerClosed
        Test-SetupNvidia $StrataBackend
        if (-not (Test-Path -LiteralPath $StrataDirectory)) {
            Invoke-Checked 'git.exe' @('clone', 'https://github.com/Niko1221/Strata.git', $StrataDirectory)
        }
        $startHere = Join-Path $StrataDirectory 'START-HERE.bat'
        if (-not (Test-Path -LiteralPath $startHere -PathType Leaf)) {
            throw "Existing folder is not a Strata installation: $StrataDirectory. Choose another -StrataDirectory."
        }
        Push-Location $StrataDirectory
        try {
            Invoke-Checked $startHere @('--check')
            $setupArgs = @('--yes', '--family', 'qwen', '--context', "$StrataContext",
                '--host', '127.0.0.1', '--port', '1234', '--kv-streaming', 'auto', '--no-start')
            if ($StrataBackend -ne 'auto') { $setupArgs += @('--backend', $StrataBackend) }
            if (Test-Path -LiteralPath (Join-Path $StrataDirectory 'engine\BUILD.json')) {
                if (-not $Yes -and -not (Confirm-SetupChoice 'Ask' 'Strata already exists. Run setup again (may change its generated config)?' $false)) {
                    throw 'Strata configuration cancelled. Existing installation left unchanged.'
                }
                $setupArgs += '--setup'
            }
            Invoke-Checked $startHere $setupArgs
            Write-Host 'Validating Strata after installation. Follow Check guidance for driver, RAM/disk or Python/engine problems.'
            Invoke-Checked $startHere @('--check')
        } finally { Pop-Location }

        $registerArgs = @((Join-Path $PSScriptRoot 'register-setup-strata.ts'),
            $StrataDirectory, "$StrataContext")
        if ($StrataConfig) { $registerArgs += [IO.Path]::GetFullPath($StrataConfig) }
        Assert-ManagerClosed
        Invoke-Checked (Join-Path $repo 'node_modules\.bin\tsx.cmd') $registerArgs
    }

    Write-Host 'Building llama-manager after setup, before creating any shortcut.'
    Invoke-Checked 'npm.cmd' @('run', 'build')

    if (Confirm-SetupChoice $Shortcut 'Create the Windows Terminal shortcut and open Explorer for pinning?' ([bool]$Yes)) {
        & (Join-Path $PSScriptRoot 'setup-windows-shortcut.ps1')
    }
    Write-Host 'Setup finished.'
    Write-SetupNextSteps $wantStrata
} finally { Pop-Location }
