#Requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$NoExplorer
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'Shortcut setup requires Windows.'
}

$repo = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $repo 'dist\main.js'
$icon = Join-Path $repo 'llama.ico'
$shortcutPath = Join-Path $repo 'Llama Manager.lnk'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw 'Built application not found. Run npm install and npm run build in the repository first.'
}
if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) {
    throw "Shortcut icon not found: $icon"
}

$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    throw 'Node.js was not found on PATH. Activate your Node installation and rerun this script.'
}
$terminal = Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $terminal) {
    throw 'Windows Terminal was not found. Install it and reopen PowerShell before rerunning this script.'
}

# Encode the command so spaces, apostrophes and Unicode paths survive both command-line parsers.
$nodeLiteral = $node.Source.Replace("'", "''")
$entryLiteral = $entryPoint.Replace("'", "''")
$command = "& '$nodeLiteral' '$entryLiteral'; exit `$LASTEXITCODE"
$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $terminal.Source
$shortcut.Arguments = "-w new -d `"$repo`" `"$powershell`" -NoProfile -EncodedCommand $encodedCommand"
$shortcut.WorkingDirectory = $repo
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = 'Launch llama-manager in Windows Terminal'
$shortcut.Save()

Write-Host "Created shortcut: $shortcutPath"
Write-Host "Node executable: $($node.Source)"
Write-Host 'To pin it, right-click Llama Manager.lnk in Explorer, choose Show more options (if needed), then Pin to taskbar.'
Write-Host 'If an older shortcut is already pinned, unpin it first and pin the newly generated shortcut.'
Write-Host 'Windows does not provide reliable automatic taskbar pinning for ordinary PowerShell setup scripts.'

if (-not $NoExplorer) {
    $explorer = Join-Path $env:SystemRoot 'explorer.exe'
    Start-Process -FilePath $explorer -ArgumentList "/select,`"$shortcutPath`""
}
