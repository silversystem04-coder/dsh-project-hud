# install.ps1 -- put dsh-project-hud into a DeepSeek Harness desktop profile.
#
# Three steps, same as the other hand-written plugins:
#   1. copy the source to <profile>\plugins\dsh-project-hud
#   2. overwrite-copy to <profile>\node_modules\dsh-project-hud (Node caches modules by
#      realpath, so the whole directory is replaced on every run)
#   3. append an `insert` block to cordis.patch.yml when it is not there yet
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI.
# Chinese notes belong in README.md.
#
# -BrainDir is where projects.json and the handoff docs live. It is optional:
# without it the plugin still shows live session cards and cards you add yourself.
#
# After installing, reload the page: a new Client package changes the boot graph.
# Changing index.js (the host half) additionally needs a DSH restart.

[CmdletBinding()]
param(
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$BrainDir = ''
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$src = $PSScriptRoot
$pluginName = 'dsh-project-hud'
$destPlugins = Join-Path $Profile "plugins\$pluginName"
$destModules = Join-Path $Profile "node_modules\$pluginName"
$patchFile = Join-Path $Profile 'cordis.patch.yml'

if (-not (Test-Path $patchFile)) { throw "cannot find $patchFile -- wrong profile path?" }

function Sync-Dir([string]$from, [string]$to) {
  if (Test-Path $to) { Remove-Item -Recurse -Force $to }
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  Copy-Item (Join-Path $from 'index.js') $to -Force
  Copy-Item (Join-Path $from 'package.json') $to -Force
  foreach ($extra in @('README.md', 'LICENSE', 'test.mjs')) {
    $p = Join-Path $from $extra
    if (Test-Path $p) { Copy-Item $p $to -Force }
  }
  Copy-Item (Join-Path $from 'lib') (Join-Path $to 'lib') -Recurse -Force
}

Sync-Dir $src $destPlugins
Sync-Dir $src $destModules
Write-Host "copied  $destPlugins"
Write-Host "copied  $destModules"

$existing = [System.IO.File]::ReadAllText($patchFile, $Utf8NoBom)
if ($existing -match "dsh-project-hud") {
  Write-Host "patch   already present, skipped"
} else {
  $config = ''
  if ($BrainDir) {
    $escaped = $BrainDir.Replace('\', '\\')
    $config = "`n        brainDir: '$escaped'"
  }
  $block = @"

# --- project-hud (top-edge project tabs) -------------------------------------
# A row of small tags hanging from the window's top edge. Hover one and a card drops
# down: what this line is, stage progress, the current step, the remaining steps from
# the handoff doc, and what to watch out for. Live sessions and hand-written cards
# show up there too.
# Source and notes: plugins/dsh-project-hud/README.md
# Uninstall: delete this insert block and reload the client.
- insert:
    - id: project-hud
      name: 'dsh-project-hud'
      config:
        maxTabs: 5
        cacheMs: 5000$config
"@
  $bytes = [System.IO.File]::ReadAllBytes($patchFile)
  if ($bytes.Length -gt 0 -and $bytes[$bytes.Length - 1] -ne 10) {
    $block = "`n" + $block
  }
  $append = $Utf8NoBom.GetBytes($block)
  $out = New-Object byte[] ($bytes.Length + $append.Length)
  [Array]::Copy($bytes, 0, $out, 0, $bytes.Length)
  [Array]::Copy($append, 0, $out, $bytes.Length, $append.Length)
  [System.IO.File]::WriteAllBytes($patchFile, $out)
  Write-Host "patch   appended to $patchFile"
}

Write-Host ''
Write-Host 'Reload the page now. The tags appear along the top edge of the window.' -ForegroundColor Green
