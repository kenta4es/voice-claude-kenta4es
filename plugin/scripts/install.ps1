# Voice Claude Kenta4es — installer
# Run once. Requires: Windows 10+, Node.js, AutoHotkey v2 (auto-checked).

$ErrorActionPreference = 'Stop'

Write-Host "=== Voice Claude Kenta4es installer ===" -ForegroundColor Cyan

# Detect plugin root (script is in <plugin>/scripts/, root is parent)
$pluginRoot = Split-Path -Parent $PSScriptRoot
Write-Host "Plugin root: $pluginRoot"

# Targets
$installDir = "$env:LOCALAPPDATA\VoiceClaudeKenta4es"
$ahkStartup = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\claude-tts-hotkeys.ahk"

# ---------- 1. Check prerequisites ----------
Write-Host "`n[1/5] Checking prerequisites..." -ForegroundColor Yellow

# Node.js
try {
    $nodeVer = & node -v 2>&1
    Write-Host "  Node.js: $nodeVer"
} catch {
    Write-Host "  ERROR: Node.js not found. Install from https://nodejs.org/ (LTS)" -ForegroundColor Red
    exit 1
}

# AutoHotkey v2
$ahkExe = "C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe"
$ahkExe86 = "C:\Program Files (x86)\AutoHotkey\v2\AutoHotkey64.exe"
if (Test-Path $ahkExe) { $ahkPath = $ahkExe }
elseif (Test-Path $ahkExe86) { $ahkPath = $ahkExe86 }
else {
    Write-Host "  ERROR: AutoHotkey v2 not found. Install from https://www.autohotkey.com/" -ForegroundColor Red
    exit 1
}
Write-Host "  AutoHotkey v2: $ahkPath"

# ---------- 2. Copy MCP files ----------
Write-Host "`n[2/5] Copying MCP server files to $installDir ..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item "$pluginRoot\mcp\server.js" "$installDir\server.js" -Force
Copy-Item "$pluginRoot\mcp\tts-engine.ps1" "$installDir\tts-engine.ps1" -Force
Copy-Item "$pluginRoot\mcp\start-tts-hidden.vbs" "$installDir\start-tts-hidden.vbs" -Force
Copy-Item "$pluginRoot\mcp\package.json" "$installDir\package.json" -Force

# Update VBS to point to actual install path
$vbsContent = Get-Content "$installDir\start-tts-hidden.vbs" -Raw
$vbsContent = $vbsContent -replace 'C:\\ClaudeTTS\\server\.js', ($installDir.Replace('\','\\') + '\\server.js')
Set-Content "$installDir\start-tts-hidden.vbs" $vbsContent -Encoding ASCII

# ---------- 3. Install npm deps ----------
Write-Host "`n[3/5] Installing npm dependencies (@modelcontextprotocol/sdk) ..." -ForegroundColor Yellow
Push-Location $installDir
try {
    & npm install --silent 2>&1 | Out-Null
    Write-Host "  npm install OK"
} catch {
    Write-Host "  WARN: npm install reported errors. Run manually: cd $installDir; npm install" -ForegroundColor Yellow
}
Pop-Location

# ---------- 4. Register Scheduled Task (autostart server) ----------
Write-Host "`n[4/5] Registering Scheduled Task 'VoiceClaudeKenta4es' (autostart at logon) ..." -ForegroundColor Yellow
$userId = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$installDir\start-tts-hidden.vbs`"" -WorkingDirectory $installDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
Unregister-ScheduledTask -TaskName 'VoiceClaudeKenta4es' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'VoiceClaudeKenta4es' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Voice Claude Kenta4es — TTS server autostart' | Out-Null
Write-Host "  Task registered"

# ---------- 5. Install AHK hotkeys to Startup ----------
Write-Host "`n[5/5] Installing AHK hotkeys to user Startup folder ..." -ForegroundColor Yellow
Copy-Item "$pluginRoot\hotkeys\claude-tts-hotkeys.ahk" $ahkStartup -Force
Write-Host "  Hotkey script: $ahkStartup"

# Kill any existing AHK / node server.js
Get-Process AutoHotkey64 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

# Start them now
Start-ScheduledTask -TaskName 'VoiceClaudeKenta4es'
Start-Process -FilePath $ahkPath -ArgumentList "`"$ahkStartup`""

Write-Host "`n=== Install complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Hotkeys (left Ctrl + left Alt):"
Write-Host "  Z       — toggle pause/resume"
Write-Host "  A       — stop"
Write-Host "  C       — system mute"
Write-Host "  Up/Down — speech rate"
Write-Host "  Left/Right — switch Russian voice"
Write-Host ""
Write-Host "TTS HTTP API: http://127.0.0.1:48329  (POST /speak, GET /toggle-pause, etc.)"
Write-Host ""
Write-Host "Voice dictation (STT) is a separate optional step — see docs/whisper-groq-setup.md"
