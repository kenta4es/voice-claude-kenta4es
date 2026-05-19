# Architecture

## Process model

The TTS stack is intentionally **single-instance for the audio engine** but **multi-instance friendly for MCP**. This solves the original mismatch problem where Claude Desktop's MCP child and the AutoHotkey HTTP client were hitting two separate SAPI engines.

```
┌────────────────────────────────────────────────────────────────┐
│ Owner instance (autostart, lives across Claude Desktop quits)  │
│   node server.js                                               │
│   ├─ HTTP server listening on 127.0.0.1:48329  ← owner         │
│   ├─ Spawns 1× tts-engine.ps1 (SAPI SpeechSynthesizer)         │
│   └─ Holds all state.json (voice, rate, volume)                │
└────────────────────────────────────────────────────────────────┘
                                ▲
                                │ HTTP forward (POST /speak, GET /toggle-pause, ...)
                                │
┌────────────────────────────────────────────────────────────────┐
│ Forwarder instance(s) — one spawned by Claude Desktop per MCP  │
│   node server.js                                               │
│   ├─ HTTP listen() fails with EADDRINUSE → isHttpOwner = false │
│   ├─ Does NOT spawn engine                                     │
│   └─ MCP handlers (speak/stop/pause/...) forward via HTTP      │
└────────────────────────────────────────────────────────────────┘
```

When `server.js` starts, it tries to bind `127.0.0.1:48329`. The first one wins (`isHttpOwner = true`, starts engine, loads state, registers all HTTP routes). Any subsequent instance gets `EADDRINUSE`, flips `isHttpOwner = false`, skips engine startup, and routes its MCP calls through HTTP to the owner.

This means the AutoHotkey hotkeys, the MCP `speak` from Claude Desktop, and any third-party app talking to `127.0.0.1:48329/speak` all converge on **one** audio engine instance. Pause actually pauses the speech the user is currently hearing.

## HTTP endpoints

All endpoints respond with `text/plain; charset=utf-8`.

### Playback control
| Method | Path | Body / Query | Response | Notes |
|---|---|---|---|---|
| POST | `/speak` | raw UTF-8 text | `Speaking N chars` | Fire-and-forget, async |
| GET | `/stop` | — | `STOPPED` / `NOTHING` | |
| GET | `/pause` | — | `OK` | |
| GET | `/resume` | — | `OK` | |
| GET | `/toggle-pause` | — | `PAUSED` / `RESUMED` / `NOTHING` | |
| GET | `/state` | — | `Speaking` / `Paused` / `Ready` | |
| GET | `/ping` | — | `PONG` | |

### Voice / rate / volume
| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/voice-next` | — | new voice name |
| GET | `/voice-prev` | — | new voice name |
| GET | `/voice-cycle` | — | new voice name (= `/voice-next`) |
| GET | `/voice-set` | `?name=Dmitry` (substring OK) | matched full name |
| GET | `/rate-up` | — | new rate (-10..10) |
| GET | `/rate-down` | — | new rate |
| GET | `/rate-set` | `?val=N` | new rate |
| GET | `/volume-set` | `?val=0..100` | new volume |

## Engine protocol (server.js ⇄ tts-engine.ps1)

Stdin lines:

| Command | Argument | Engine response |
|---|---|---|
| `SPEAK <base64-utf8>` | text | `OK` |
| `STOP` | — | `STOPPED` / `NOTHING` |
| `PAUSE` | — | `OK` |
| `RESUME` | — | `OK` |
| `TOGGLE` | — | `PAUSED` / `RESUMED` / `NOTHING` |
| `STATE` | — | `Speaking` / `Paused` / `Ready` |
| `VOICE <name>` | full SAPI name | `OK` / `ERR ...` |
| `RATE <-10..10>` | int | `OK` |
| `VOLUME <0..100>` | int | `OK` |
| `PING` | — | `PONG` |

The engine tracks `$script:isPaused` manually because `$s.State` does not always update synchronously in PowerShell STA mode without a message pump.

## State persistence

State is written to `%TEMP%\claude-tts-state.json` on every change. Schema:

```json
{
  "voice": "Microsoft Dmitry Online",
  "rate": 1,
  "volume": 100,
  "removePunctuationPauses": false
}
```

On startup the owner instance loads this file, then issues `VOICE`, `RATE`, `VOLUME` commands to the engine.

## Autostart

A user-level Scheduled Task `VoiceClaudeKenta4es` triggers at logon and runs:

```
wscript.exe "<install-dir>\start-tts-hidden.vbs"
```

The VBS uses `WScript.Shell.Run "...node.exe...server.js", 0, False` — window mode 0 hides the console, async=False detaches.

## AutoHotkey

`claude-tts-hotkeys.ahk` uses strict left-Ctrl + left-Alt + scan-code hotkeys to be layout-independent (the same Z key on RU and EN layouts produces different VK codes but the same scan code `0x2C`). It calls the HTTP endpoints via `WinHttp.WinHttpRequest.5.1` COM object, reads response, and shows a tooltip for 1.5 s.

For UTF-8 POST bodies (when an extension is later added for arbitrary text), use `ADODB.Stream` to encode the AHK UTF-16 string into UTF-8 bytes before `http.Send(stream.Read())`.
