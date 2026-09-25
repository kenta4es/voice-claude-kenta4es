# Changelog

All notable changes to this project.

## [1.2.6] — 2026-09-25

One queue for everything, with an audible boundary between messages.

### Added

- **"Next message" separator.** When a new message arrives while another one
  is still playing or queued, the engine inserts a 2-second pause and says
  «Следующее сообщение» before it. A message that arrives when the voice is
  idle is read immediately, without the separator. Continuations of the same
  reply (`speak` with `queue=true`) are appended without it. The separator is
  spoken in the current voice (SAPI `PromptBuilder` pinned to that voice).

### Fixed

- **`Ctrl+Alt+Z` interrupted whatever was playing.** The hotkey script sent
  `/stop` before reading the selection, which cut off the current speech and
  wiped the queue. The selection is now queued like any other message.

### Verified (silent, volume 0, engine busy-time measured)

| Scenario | Queued | Interrupted | Result |
|---|---|---|---|
| Reply from another chat while speaking | ~20.3 s | ~11.8 s | 23.1 s — queued + separator |
| `Ctrl+Alt+Z` while speaking | ~20.5 s | ~11.8 s | 22.6 s — queued + separator |
| Continuation of the same reply | ~20.3 s | ~11.8 s | 20.2 s — queued, no separator |

## [1.2.5] — 2026-09-25

Auto-voicing reads only what you actually see.

### Fixed

- **Auto-voicing read Claude's intermediate steps aloud** — the short notes
  written between tool calls ("Checking what's available for Georgia:",
  "Reading it in the browser:"), usually in English, plus API error lines
  ("Failed to authenticate. API Error: 403"). Cowork shows those notes only
  folded into steps, so they sounded like random system chatter. The watcher
  (`tts-watch.cjs`, v4) now voices only the final answer — text after the
  last tool call — and messages sent to the user mid-task
  (`send_user_message`). Narration, API errors and mostly-English text are
  skipped. Verified with a dry run over a real 1,228-turn chat: only the
  Russian final answers remained.
- **The watcher only worked on the author's PC.** The Cowork sessions folder
  was hard-coded as `C:\Users\Alexander\…`; it is now taken from `%APPDATA%`.

### Tip

Claude may write those intermediate notes in English even when told to
"respond in Russian" — it treats them as internal. To get Russian
everywhere, put this in Settings → Account → *Instructions for Claude*:
`Russian for ALL text — final answers, intermediate notes between tool
calls, progress messages, questions, summaries. Never switch to English.`

## [1.2.4] — 2026-09-24

Night mode: silence the voice with one key, without closing anything.

### Added

- **`LCtrl+LAlt+A` — mute / unmute the voice.** Muting remembers the current
  volume; unmuting restores it (mute at 70 % → unmute → 70 %, not 100 %).
- **`LCtrl+LAlt+=` / `-`** (also numpad `+` / `-`) — voice volume ±10, clamped
  to 0–100. Each press shows a tooltip: "Озвучка: ВЫКЛ", "Озвучка: ВКЛ — 70%",
  "Громкость озвучки: 60%". Only the voice changes, not Windows volume.
  All three keys were checked to be free of global registrations.
- HTTP: `GET /mute-toggle`, `/volume-up`, `/volume-down`, and
  `GET /volume-state` → `{"saved","lastVolume","engine"}` — the saved setting
  next to what the engine is really using (new engine command `GETVOL`).

### Fixed

- **A restarted engine ignored the saved volume, rate and voice.** After
  `Ctrl+Alt+R`, a stop timeout or a crash, the fresh engine started at SAPI
  defaults — volume 100 — while the settings still said otherwise. A muted
  voice would suddenly come back at full volume in the middle of the night.
  The server now re-applies volume, rate and voice every time the engine
  restarts. Verified: after `Ctrl+Alt+R` the engine reports volume 0.
- **Hotkey log path was hard-coded to `D:\Claude\` since the first release.**
  On machines without that folder every hotkey could fail on logging. The log
  now goes to `%TEMP%\claude-tts-hotkeys.log`.

## [1.2.3] — 2026-09-23

Dictation without invented words: Deepgram Nova-3 replaces Whisper as the
recommended speech engine. Still free. No changes to the TTS code.

### Why

Whisper kept appending phrases that were never spoken — "Продолжение
следует", "Субтитры делал…", and plausible tails like "и я могу". It learned
them from YouTube subtitles and fills pauses with them. Cloud APIs (Groq,
OpenAI) do not expose Whisper's anti-hallucination thresholds, and a cleanup
LLM cannot tell an invented tail from real speech. The strict cleanup prompt
from 1.2.2 was a safety net, not a cure.

### Added

- **Deepgram Nova-3 setup** in `docs/whisper-groq-setup.md` and `CLAUDE.md`:
  $200 free credit, no card, never expires (~3 years of heavy dictation);
  what "Credit" in the console means; how the dictionary works as Deepgram
  *keyterms* (a recognition boost that does not leak into pauses, and whose
  spelling controls Cyrillic vs Latin output — `СДЭК`, `Bybit`).
- **`tools/openwhispr-set-language.ps1`** (+ `.mjs`): sets OpenWhispr's
  dictation language. OpenWhispr 1.10 asks for it only during onboarding and
  has no setting afterwards; left on "auto", Nova-3 writes Russian speech as
  English words. The script restarts OpenWhispr with a local debugging port,
  writes `preferredLanguage`, and always restarts it normally afterwards.
  Verified end to end.
- Three OpenWhispr gotchas we hit, each with its fix: the Nova-3 row must be
  clicked to become "Active"; OpenWhispr must be restarted after adding a
  Deepgram key (`No deepgram API key configured`); Deepgram is live-only, so
  Re-transcribe and Audio Upload do not work with it.
- Why local models are not recommended on weak PCs (2-core CPU: 25–45 s per
  minute of speech).

### Fixed

- The 1.2.2 guide said the language cannot be set in OpenWhispr 1.10 — it can,
  with the script above.
- Measuring your dictation volume: copy `transcriptions.db` **together with**
  its `-wal` file; the `.db` alone silently misses recent dictations.

## [1.2.2] — 2026-09-22

Dictation quality: proper Russian punctuation without polluting the Whisper
prompt. Docs and config only — no code changes to the TTS stack.

### Added

- **`docs/openwhispr-cleanup-prompt.txt`** — a strict prompt for OpenWhispr's
  Dictation Cleanup. It places commas by Russian rules (conjunctions,
  обращения, вводные слова, причастные/деепричастные обороты), puts a question
  mark on every question, strips trailing subtitle artifacts ("Продолжение
  следует", "Субтитры делал…") — and never answers, adds, drops or reorders
  words. Verified in Prompt Studio: a request about the weather came back
  punctuated, not answered.
- **Cost section** in `docs/whisper-groq-setup.md`: official OpenAI prices
  (gpt-4o-transcribe $0.006/min, gpt-transcribe $0.0045/min,
  gpt-4o-mini-transcribe $0.003/min), a monthly estimate from a real measured
  volume (~820 min/month → $2.5–5), how to measure your own volume from
  OpenWhispr's `transcriptions.db`, and why NVIDIA build.nvidia.com is not a
  drop-in alternative.

### Changed

- **Dictation Cleanup is now recommended ON** — with Groq **GPT-OSS 120B**
  and the strict prompt. Previous advice was to turn it off, because small
  models (Llama 8B) answered questions instead of cleaning them and leaked
  `<|python_tag|>` tokens. The problem was the model and the prompt, not the
  feature.
- STT model recommendation: **Whisper Large v3** instead of Large v3 Turbo —
  Turbo drops periods and question marks in Russian.
- Guide tested on **OpenWhispr 1.10.2**; documented that the in-app updater
  silently fails for per-machine installs and how to run the pending installer
  by hand.
- Removed the advice to put sample phrases into the dictionary for punctuation
  and the "set Language = Russian" step (OpenWhispr 1.10 has no language
  selector for cloud dictation).

## [1.2.1] — 2026-08-22

Root-cause fix for the whole family of "it just went silent and nothing works"
failures. Everything below was one bug wearing different masks.

### Fixed

- **The engine dying took the entire server with it.** Writing to the stdin of a
  dead child process emits an asynchronous `EPIPE` on the stream, and an
  unhandled stream error is a *fatal* uncaught exception in Node. So the moment
  the speech engine died — a wedged cloud voice, a lost audio endpoint — the
  server died too. No `/ping`, no `/stop`, no hotkeys, nothing left alive to
  recover it. Stream errors are now swallowed and the engine is respawned.
  Measured: killing the engine used to leave a dead server after 4.1 s; it now
  answers `/stop` in **36 ms** and comes back on its own.
- **Commands could wait forever.** `sendCmd` had no deadline: if the engine
  never answered, the HTTP request never returned, the hotkey's 2 s timeout
  fired, and Stop looked broken while speech kept playing. Every command now has
  a timeout; playback controls use a short one (1.5 s).
- **Stop that cannot fail.** If the engine does not confirm a stop in time it is
  considered wedged and killed outright — killing the process kills its audio,
  so pressing Stop always produces silence. A fresh engine starts a second later.
- **Added a last-resort process guard** (`uncaughtException` /
  `unhandledRejection`). For a background service, staying alive and logging
  beats dying silently.

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
