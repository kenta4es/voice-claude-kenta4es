# Changelog

All notable changes to this project.

## [1.2.0] — 2026-08-18

Everything in this release came out of two months of daily use. Most changes are
fixes for failure modes that produced the same confusing symptom — **"the server
says `Speaking`, but I hear nothing"** — plus one new feature that was on the
1.1 wishlist: reading selected text aloud from any window.

### Added

- **Read selected text aloud — `LCtrl+LAlt+Z`.** Works in any application:
  select text, press the hotkey, hear it. Implemented in
  `plugin/hotkeys/claude-tts-hotkeys.ahk` + `plugin/mcp/speak-file.ps1`.
  (Was listed as a "future idea" in 1.1.)
- **VS Code extension** (`vscode-extension/`) — adds
  *"Озвучить выделение"* to the editor context menu; talks to the same local
  server, so it shares the queue, pause and stop with everything else.
- **Restart / recover hotkey — `LCtrl+LAlt+R`.** Restarts the speech engine and,
  if the server itself died, brings the whole stack back up, then re-applies the
  preferred voice and confirms out loud. This is the one-key fix for any
  "suddenly silent" situation. Script: `plugin/mcp/tts-restart.ps1`.
- **Preferred voice is now a setting, not hard-coded** — `plugin/mcp/voice.txt`.
  Every script reads it, so changing the voice everywhere is a one-line edit.
- **Chat-reply safety net** (`plugin/mcp/tts-watch.cjs`, optional) — watches the
  Cowork session transcripts and voices a reply if the model forgot to call
  `speak` itself. Decides **per turn**, so it never double-speaks a reply the
  model already voiced. Single-instance lock on port 48331.

### Changed

- **Hotkey layout reworked — one key, one action:**

  | Key | 1.1 | 1.2 |
  |---|---|---|
  | `Z` | pause / resume | **speak selected text** |
  | `X` | — | **pause / resume** |
  | `C` | system mute | **stop** |
  | `A` | stop | *(freed)* |
  | `R` | — | **restart / recover speech** |

  `C` no longer touches system volume — muting Windows also killed music and
  video, which was never the intent.
- **Default voice is now `Svetlana`** (see "Known issue: Dmitry" below).
- **No more automatic fallback to the offline voice.** 1.1 probed the internet at
  startup and silently switched to `Irina` if the probe failed. With a VPN active
  the probe fails constantly, so the voice kept changing on its own. The
  configured voice is now applied as-is.

### Fixed

- **Audio went to a dead output device.** A long-lived synthesizer binds to the
  audio endpoint it saw at startup. If Windows later changes the default output
  (common on machines with several devices — HDMI, virtual cables, etc.), speech
  kept being written to the old endpoint: state said `Speaking`, nothing was
  heard. The engine now re-binds to the current default device before every
  utterance.
- **Stop could not stop anything.** `STOP` used to check `$synth.State` first and
  skip cancelling when it reported `Ready` — but SAPI frequently reports `Ready`
  while audio is still playing. Stop is now unconditional.
- **A stuck pause blocked all later speech.** Queued utterances did not clear the
  paused state, so everything piled up behind a pause nobody could see. Queued
  speech now resumes a paused engine.
- **Recovery script could make things worse.** It killed the engine assuming the
  server would respawn it — if the server itself was dead, that left no audio at
  all. It now checks the server first and starts the whole stack when needed.

### Known issue: the "Dmitry" voice

`Microsoft Dmitry Online` is not a local Windows voice — it is an **Edge cloud
neural voice** exposed through a SAPI bridge. On our machine it stopped
returning audio entirely: synthesis to a WAV file produces a 46-byte header and
no samples, and the call often hangs for 30+ seconds. Other voices through the
exact same path (`Svetlana`, `AndrewMultilingual`, `BrianMultilingual`) work
normally, so this is specific to that voice on Microsoft's side — it cannot be
fixed locally, and the voice cannot be downloaded for offline use.

**Workaround:** default is now `Svetlana`. Working male alternatives:
`BrianMultilingual` / `AndrewMultilingual` (neural, multilingual, speak Russian),
or the offline `Microsoft Pavel` (Windows 10 ships it in the OneCore hive; making
it visible to classic SAPI needs a one-time registry token copy — see
`docs/troubleshooting.md`).

**How to test any voice in 10 seconds:** synthesize to a file and look at its
size. A ~46-byte WAV means the voice produced no audio at all:

```powershell
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Svetlana Online')
$s.SetOutputToWaveFile("$env:TEMP\voicetest.wav"); $s.Speak('Проверка голоса'); $s.Dispose()
(Get-Item "$env:TEMP\voicetest.wav").Length   # 46 = silence, >100000 = real audio
```

## [1.1.0] — 2026-07-01

- Initial public release: MCP server, `voice-output` skill, AutoHotkey hotkeys,
  autostart Scheduled Task, single-owner HTTP architecture, Whisper + Groq
  dictation guide.
