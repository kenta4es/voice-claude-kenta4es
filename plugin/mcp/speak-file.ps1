# Speak the text stored in speak-sel.txt (written by the AHK hotkey).
# POSTs raw UTF-8 bytes to /speak: appended after current speech (never interrupts),
# as a separate message - the engine announces it with a pause + "next message".
# ASCII-only source on purpose (PS 5.1 encoding safety).

$ErrorActionPreference = 'SilentlyContinue'
$u = 'http://127.0.0.1:48329'
$f = 'C:\ClaudeTTS\speak-sel.txt'
$log = 'C:\ClaudeTTS\speak-file.log'
function L($m) { Add-Content -Path $log -Value ((Get-Date).ToString('s') + ' ' + $m) }

if (-not (Test-Path $f)) { L 'no file'; exit }

$bytes = [System.IO.File]::ReadAllBytes($f)
L ("bytes: " + $bytes.Length)

function Test-Server {
    try { return ((Invoke-WebRequest -UseBasicParsing -Uri "$u/ping" -TimeoutSec 3).Content -match 'PONG') } catch { return $false }
}

# No stop here: the selection is QUEUED after whatever is already speaking
# (another chat, a previous selection). Ctrl+Alt+C clears the queue if needed.

# If the server is down, bring the whole stack up (engine alone can't respawn).
if (-not (Test-Server)) {
    Start-Process -FilePath 'C:\Windows\System32\wscript.exe' -ArgumentList 'C:\ClaudeTTS\start-tts-hidden.vbs' -WindowStyle Hidden
    for ($i = 0; $i -lt 25; $i++) { Start-Sleep -Milliseconds 500; if (Test-Server) { break } }
    L 'server was down -> started'
}
Start-Sleep -Milliseconds 150

try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$u/speak" -ContentType 'text/plain; charset=utf-8' -Body $bytes -TimeoutSec 8
    L ("speak: " + $r.Content)
} catch {
    L ("speak err: " + $_.Exception.Message)
}
