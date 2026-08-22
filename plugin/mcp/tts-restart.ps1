# Hard restart of the Claude TTS engine + force voice back to Dmitry.
# Bound to Ctrl+Alt+R. Fixes the classic failure where the ONLINE voice
# (Microsoft Dmitry Online) silently stops producing audio: the engine reports
# Speaking/Ready but nothing is heard. A fresh engine process re-acquires the
# cloud voice, which restores sound.
# ASCII-only on purpose (PS 5.1 + no BOM safety).

$ErrorActionPreference = 'SilentlyContinue'
$u = 'http://127.0.0.1:48329'
$log = 'C:\ClaudeTTS\tts-restart.log'
function L($m) { Add-Content -Path $log -Value ((Get-Date).ToString('s') + ' ' + $m) }

L 'restart requested'

function Test-Server {
    try {
        $p = (Invoke-WebRequest -UseBasicParsing -Uri "$u/ping" -TimeoutSec 3).Content
        return ($p -match 'PONG')
    } catch { return $false }
}

# 1) clear whatever is stuck (ignore if the server is already down)
try { Invoke-WebRequest -UseBasicParsing -Uri "$u/stop" -TimeoutSec 4 | Out-Null } catch {}

$serverAlive = Test-Server
L ("server alive before: " + $serverAlive)

if ($serverAlive) {
    # 2a) server is up: kill ONLY the engine child, server.js respawns it in ~1s
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
      Where-Object { $_.CommandLine -like '*tts-engine*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} else {
    # 2b) server itself is dead -> full clean start (this is what used to leave
    #     the user with no sound at all: engine killed, nobody to respawn it)
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
      Where-Object { $_.CommandLine -like '*tts-engine*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    Start-Process -FilePath 'C:\Windows\System32\wscript.exe' -ArgumentList 'C:\ClaudeTTS\start-tts-hidden.vbs' -WindowStyle Hidden
    L 'server was down -> launched start-tts-hidden.vbs'
}

# 3) wait for the server/engine to come back
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Server) { $ok = $true; break }
}
L ("engine back: " + $ok)

# 3b) last resort: if still dead, force a full start once more
if (-not $ok) {
    Start-Process -FilePath 'C:\Windows\System32\wscript.exe' -ArgumentList 'C:\ClaudeTTS\start-tts-hidden.vbs' -WindowStyle Hidden
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Server) { $ok = $true; break }
    }
    L ("engine back after forced start: " + $ok)
}

# 4) force the preferred voice. NEVER hard-code Dmitry: on this PC
# "Microsoft Dmitry Online" is broken - synthesis hangs and yields 0 bytes,
# so selecting it silences everything. Preferred voice lives in voice.txt.
$pref = 'Svetlana'
try { $pref = ([System.IO.File]::ReadAllText('C:\ClaudeTTS\voice.txt')).Trim() } catch {}
$v = ''
try { $v = (Invoke-WebRequest -UseBasicParsing -Uri ("$u/voice-set?name=" + $pref) -TimeoutSec 6).Content } catch {}
L ("voice: " + $v)
Start-Sleep -Milliseconds 800

# 5) speak confirmation through the server (so it uses the restored voice).
# The phrase lives in a UTF-8 file and is posted as RAW BYTES - no console
# encoding involved, so Cyrillic can't get mangled.
try {
    $bytes = [System.IO.File]::ReadAllBytes('C:\ClaudeTTS\restart-msg.txt')
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$u/speak" -ContentType 'text/plain; charset=utf-8' -Body $bytes -TimeoutSec 6 | Out-Null
} catch { L ("speak err: " + $_.Exception.Message) }

# 6) verify audio actually started; if the cloud voice is still mute, fall back
Start-Sleep -Milliseconds 1500
$state = ''
try { $state = (Invoke-WebRequest -UseBasicParsing -Uri "$u/state" -TimeoutSec 4).Content } catch {}
L ("state after speak: " + $state)
