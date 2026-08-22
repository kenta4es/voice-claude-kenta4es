$ErrorActionPreference = 'Continue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech

$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Volume = 100
$s.Rate = 1

# Track pause state manually — SAPI $s.State may not update without message pump in STA
$script:isPaused = $false

Write-Output "READY"

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $parts = $line -split ' ', 2
    $cmd = $parts[0]
    $arg = if ($parts.Count -gt 1) { $parts[1] } else { '' }

    try {
        switch ($cmd) {
            'SPEAK' {
                # Cross-chat queue: default speak now APPENDS (no SpeakAsyncCancelAll) so speech
                # from any chat queues instead of interrupting. Use STOP to clear the queue.
                $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($arg))
                if ($script:isPaused) { try { $s.Resume() } catch {} }
                $script:isPaused = $false
                # Re-bind to the CURRENT default audio device before speaking.
                # A long-lived synthesizer keeps writing to the device captured
                # at startup; if the default output changed (this PC has AMD,
                # Realtek and a virtual "Voice Changer" device), audio goes to a
                # dead endpoint - State says Speaking but nothing is heard.
                try { $s.SetOutputToDefaultAudioDevice() } catch {}
                $s.SpeakAsync($text) | Out-Null
                Write-Output "OK"
            }
            'SPEAKQ' {
                # Queue mode: append after current speech. Also resume if paused, so a
                # stuck pause never blocks future speech.
                $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($arg))
                if ($script:isPaused) { try { $s.Resume() } catch {} }
                $script:isPaused = $false
                # Re-bind to the CURRENT default audio device before speaking.
                # A long-lived synthesizer keeps writing to the device captured
                # at startup; if the default output changed (this PC has AMD,
                # Realtek and a virtual "Voice Changer" device), audio goes to a
                # dead endpoint - State says Speaking but nothing is heard.
                try { $s.SetOutputToDefaultAudioDevice() } catch {}
                $s.SpeakAsync($text) | Out-Null
                Write-Output "OK"
            }
            'STOP' {
                # ALWAYS cancel. The old code skipped cancelling when
                # $s.State reported "Ready" - but SAPI often reports Ready
                # while audio is still playing (no message pump in this loop),
                # so Stop silently did nothing and speech could not be aborted.
                $st = $s.State.ToString()
                try { $s.SpeakAsyncCancelAll() | Out-Null } catch {}
                if ($script:isPaused) { try { $s.Resume() } catch {} }
                $script:isPaused = $false
                if ($st -eq 'Ready') { Write-Output "STOPPED" } else { Write-Output "STOPPED" }
            }
            'PAUSE' {
                if (-not $script:isPaused) {
                    try { $s.Pause(); $script:isPaused = $true } catch {}
                }
                Write-Output "OK"
            }
            'RESUME' {
                if ($script:isPaused) {
                    try { $s.Resume(); $script:isPaused = $false } catch {}
                }
                Write-Output "OK"
            }
            'TOGGLE' {
                $st = $s.State.ToString()
                if ($script:isPaused -or $st -eq 'Paused') {
                    try { $s.Resume(); $script:isPaused = $false; Write-Output "RESUMED" } catch { Write-Output ("ERR " + $_.Exception.Message) }
                } elseif ($st -eq 'Speaking') {
                    try { $s.Pause(); $script:isPaused = $true; Write-Output "PAUSED" } catch { Write-Output ("ERR " + $_.Exception.Message) }
                } else {
                    Write-Output "NOTHING"
                }
            }
            'VOICE' {
                try { $s.SelectVoice($arg); Write-Output "OK" } catch { Write-Output ("ERR " + $_.Exception.Message) }
            }
            'RATE' { $s.Rate = [int]$arg; Write-Output "OK" }
            'VOLUME' { $s.Volume = [int]$arg; Write-Output "OK" }
            'STATE' {
                $st = $s.State.ToString()
                if ($script:isPaused -or $st -eq 'Paused') { Write-Output "Paused" }
                elseif ($st -eq 'Speaking') { Write-Output "Speaking" }
                else { Write-Output "Ready" }
            }
            'PING' { Write-Output "PONG" }
            default { Write-Output "UNKNOWN" }
        }
    } catch {
        Write-Output ("ERR " + $_.Exception.Message)
    }
}
