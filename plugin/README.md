# Voice Claude Kenta4es — Cowork Plugin

This is the Cowork plugin distribution of Voice Claude Kenta4es. It bundles the MCP server, the `voice-output` skill, the AutoHotkey hotkey script, and an installer that wires everything up on Windows.

## What it does

- Claude reads its own replies aloud in your Claude Desktop chat (Russian neural voices: Dmitry, Svetlana; or classic Irina).
- AutoHotkey hotkeys for pause/resume, stop, voice switching, speech rate — work even when Claude Desktop is closed (TTS server runs as a background task).
- HTTP API on `127.0.0.1:48329` for any other app to call (`POST /speak`, `GET /toggle-pause`, etc.).

> Voice **input** (Whisper STT) is a separate optional layer documented in `docs/whisper-groq-setup.md` at the repo root. It does not require this plugin to be installed.

## Install

After Claude Desktop accepts the plugin, run the installer once from PowerShell:

```powershell
& "$env:USERPROFILE\AppData\Roaming\Claude\Plugins\voice-claude-kenta4es\scripts\install.ps1"
```

(The exact plugin folder may differ — adjust the path. The installer is also available as `plugin/scripts/install.ps1` in the source repo.)

## Hotkeys

| Hotkey | Action |
|---|---|
| Left Ctrl + Left Alt + Z | Pause / Resume speech |
| Left Ctrl + Left Alt + A | Stop |
| Left Ctrl + Left Alt + C | System mute toggle |
| Left Ctrl + Left Alt + ↑ / ↓ | Speech rate + / − |
| Left Ctrl + Left Alt + → / ← | Next / previous Russian voice |

## Prerequisites

- Windows 10 64-bit
- Node.js LTS — https://nodejs.org/
- AutoHotkey v2 — https://www.autohotkey.com/
- Russian SAPI voices — install via Windows Settings → Time & Language → Speech → Add voices

## License

MIT — see `LICENSE` in the repo root.

## Authors

Kenta4es & Claude (Anthropic)
