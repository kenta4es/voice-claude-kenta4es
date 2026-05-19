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
                $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($arg))
                $s.SpeakAsyncCancelAll() | Out-Null
                if ($script:isPaused) { try { $s.Resume() } catch {} }
                $script:isPaused = $false
                $s.SpeakAsync($text) | Out-Null
                Write-Output "OK"
            }
            'STOP' {
                $st = $s.State.ToString()
                if ($st -eq 'Ready' -and -not $script:isPaused) {
                    Write-Output "NOTHING"
                } else {
                    $s.SpeakAsyncCancelAll() | Out-Null
                    if ($script:isPaused) { try { $s.Resume() } catch {} }
                    $script:isPaused = $false
                    Write-Output "STOPPED"
                }
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
