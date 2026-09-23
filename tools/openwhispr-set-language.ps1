# Sets OpenWhispr's dictation language (default: ru).
# OpenWhispr 1.10 asks for the language only during onboarding; without it Deepgram
# Nova-3 transcribes Russian speech as English words. This script:
#   1) restarts OpenWhispr with a local-only debugging port,
#   2) writes localStorage "preferredLanguage" via openwhispr-set-language.mjs,
#   3) restarts OpenWhispr normally (debugging port closed).
# Usage:  powershell -ExecutionPolicy Bypass -File openwhispr-set-language.ps1 [-Lang ru]
# Requires Node.js 20.10+ (22+ recommended). Do not dictate while it runs (~25 s).
param([string]$Lang = "ru", [int]$Port = 9229)
$ErrorActionPreference = "Stop"

$candidates = @(
  "$env:LOCALAPPDATA\Programs\OpenWhispr\OpenWhispr.exe",
  "$env:ProgramFiles\OpenWhispr\OpenWhispr.exe",
  "D:\Program Files\OpenWhispr\OpenWhispr.exe"
)
$running = Get-Process OpenWhispr -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1
$exe = if ($running) { $running.Path } else { $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1 }
if (-not $exe) { throw "OpenWhispr.exe not found. Start OpenWhispr once and run this script again." }

$nodeMajor = [int]((node -v).TrimStart("v").Split(".")[0])
$nodeArgs = @()
if ($nodeMajor -lt 22) { $nodeArgs += "--experimental-websocket" }
$js = Join-Path $PSScriptRoot "openwhispr-set-language.mjs"

function Stop-OW { Get-Process OpenWhispr -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 3 }

try {
  Stop-OW
  Start-Process $exe -ArgumentList "--remote-debugging-port=$Port"
  $ok = $false
  foreach ($i in 1..30) {
    Start-Sleep 1
    try { if ((Invoke-RestMethod "http://127.0.0.1:$Port/json" -TimeoutSec 2) | Where-Object type -eq "page") { $ok = $true; break } } catch {}
  }
  if (-not $ok) { throw "OpenWhispr did not expose the debugging port." }
  Start-Sleep 3

  # Run node as a separate process: Windows PowerShell 5 turns node's harmless stderr
  # warning into a terminating error when $ErrorActionPreference is Stop.
  $outFile = Join-Path $env:TEMP "openwhispr-set-language.out"
  $errFile = Join-Path $env:TEMP "openwhispr-set-language.err"
  $p = Start-Process node -ArgumentList ($nodeArgs + @("`"$js`"", $Lang, $Port)) -NoNewWindow -PassThru `
         -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  if (-not $p.WaitForExit(20000)) { $p.Kill(); throw "Timed out talking to OpenWhispr." }
  $result = Get-Content $outFile -Raw
  if ($result -notmatch '"after":"') { throw "Language was not set. $result $(Get-Content $errFile -Raw)" }
  Write-Output $result.Trim()
}
finally {
  # Always leave OpenWhispr running normally, with the debugging port closed.
  Stop-OW
  Start-Process $exe
}
Write-Output "OpenWhispr restarted normally. Dictate a test phrase in the chosen language."
