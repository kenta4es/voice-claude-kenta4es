# Voice Claude Kenta4es

**Talk to Claude. Let Claude talk back.**
A complete voice I/O stack for Claude Desktop on Windows — dictate with Whisper, hear Claude reply with neural SAPI voices, control playback from system hotkeys that work in any window.

> **RU — кратко:** Полный голосовой стек для Claude Desktop на Windows. Claude читает свои ответы вслух нейронными русскими голосами (Дмитрий, Светлана, Ирина), ты диктуешь голосом через Whisper, а системные горячие клавиши (пауза / стоп / голос / скорость) работают в любом окне, даже когда Claude закрыт. Озвучка идёт **впереди текста** и проговаривает **каждый** шаг работы. Полное русское описание — в разделах ниже (установка, горячие клавиши, важное про preferences).

![platform](https://img.shields.io/badge/platform-Windows%2010%2B-blue)
![mcp](https://img.shields.io/badge/MCP-claude--tts-purple)
![license](https://img.shields.io/badge/license-MIT-green)
![author](https://img.shields.io/badge/by-Kenta4es%20%26%20Claude-black)

---

## What you get

| Capability | How |
|---|---|
| **Claude reads its replies aloud** | MCP server `claude-tts` + skill `voice-output` that Claude calls automatically at the start of every reply |
| **You dictate to Claude (and any app)** | OpenWhispr + Groq Whisper Large v3 Turbo API — set up once, dictate everywhere |
| **Pause / Stop / Voice / Rate hotkeys** | AutoHotkey v2 layout-independent hotkeys (Left Ctrl + Left Alt + Z/A/C/↑/↓/←/→) that work in any window |
| **Independent of Claude Desktop** | TTS server autostarts at logon via Scheduled Task — hotkeys keep working when Claude is closed |
| **Any app can speak too** | Local HTTP API on `127.0.0.1:48329`: `POST /speak`, `GET /toggle-pause`, `GET /voice-set?name=...` |
| **Narrate multi-step work** | Queue mode — `speak` with `queue=true` (`POST /speak?queue=1`) voices each intermediate step in order without cutting off the previous one |

Russian voices supported out of the box: **Microsoft Dmitry Online**, **Microsoft Svetlana Online** (neural), **Microsoft Irina Desktop** (classic). English voices are supported by switching with `set_voice`.

---

## ⚠️ Important for auto-speak / Важно для автоозвучки

**EN:** For Claude to read **every** reply aloud automatically, the `voice-output` skill must not be overridden by your personal preferences. If you keep a personal preference about voice, make it **match the skill** — it should say *"ALWAYS call `mcp__claude-tts__speak` as the FIRST action of each reply, voice the full reply text, and follow the `voice-output` skill."* A preference like *"speak at the end"* will win over the skill and break speak‑first. For regular **Chat** (not Cowork), also upload the skill via **Settings → Customize → Skills** (Code execution must be enabled in Settings → Capabilities).

**RU:** Чтобы Claude озвучивал **каждый** ответ сам, скилл `voice-output` не должен перебиваться твоими личными preferences. Если держишь в preferences пункт про озвучку — он должен **совпадать со скиллом**: *«ВСЕГДА вызывай `mcp__claude-tts__speak` ПЕРВЫМ действием в ответе, озвучивай весь текст ответа и следуй скиллу `voice-output`»*. Пункт вроде *«озвучивать в конце»* перебьёт скилл и сломает режим «голос впереди текста». Для обычного **Чата** (не Cowork) скилл нужно ещё загрузить через **Settings → Customize → Skills** (в Settings → Capabilities должен быть включён Code execution).

---

## Two ways to install

### 1. Cowork plugin (recommended for Claude Desktop users)

Download `voice-claude-kenta4es.plugin` from the [Releases](https://github.com/kenta4es/voice-claude-kenta4es/releases) page and drag it into Claude Desktop, or install through the plugin marketplace. Then run the post-install script once:

```powershell
& "$env:USERPROFILE\AppData\Roaming\Claude\Plugins\voice-claude-kenta4es\scripts\install.ps1"
```

This registers the autostart Scheduled Task and copies the AutoHotkey script to your Startup folder.

### 2. Standalone (no Cowork)

Clone the repo and run:

```powershell
cd .\standalone
.\install.ps1
```

Same stack, without the Cowork plugin layer. MCP integration is then configured manually in your `claude_desktop_config.json` (see `standalone/README.md`).

---

## Prerequisites

| Component | Where |
|---|---|
| Windows 10 64-bit | — |
| Node.js LTS | https://nodejs.org/ |
| AutoHotkey v2 | https://www.autohotkey.com/ |
| Russian SAPI voices (Dmitry / Svetlana) | Windows Settings → Time & Language → Speech → Add voices → Russian |

For dictation (voice **in**, optional):

| Component | Where |
|---|---|
| OpenWhispr | https://openwhispr.com/ |
| Groq API key (free tier OK) | https://console.groq.com/ |

Step-by-step Whisper + Groq setup is in [`docs/whisper-groq-setup.md`](docs/whisper-groq-setup.md).

---

## Hotkeys

All hotkeys use **Left Ctrl + Left Alt** + key, with physical scan codes so they work regardless of keyboard layout (RU/EN).

| Hotkey | Action | Tooltip |
|---|---|---|
| `LCtrl + LAlt + Z` | Toggle pause / resume current speech | "Paused" / "Resumed" / "Nothing playing" |
| `LCtrl + LAlt + A` | Stop current speech | "Stopped" / "Nothing playing" |
| `LCtrl + LAlt + C` | System volume mute toggle | "Mute toggle (C)" |
| `LCtrl + LAlt + ↑ / ↓` | Speech rate + / − | "Rate +" with new value |
| `LCtrl + LAlt + → / ←` | Cycle Russian voice forward / back | New voice name spoken |

---

## HTTP API (for other apps)

Server listens on `127.0.0.1:48329` after install. Any local app can drive TTS via simple GET/POST calls:

```powershell
# Speak any text
Invoke-WebRequest -Uri http://127.0.0.1:48329/speak -Method POST -Body 'Привет, мир!' -ContentType 'text/plain; charset=utf-8'

# Toggle pause
Invoke-WebRequest -Uri http://127.0.0.1:48329/toggle-pause -UseBasicParsing

# Switch voice
Invoke-WebRequest -Uri 'http://127.0.0.1:48329/voice-set?name=Svetlana' -UseBasicParsing
```

Full endpoint reference in [`docs/architecture.md`](docs/architecture.md).

---

## Architecture in a nutshell

```
┌──────────────────┐         ┌──────────────────────────────────────────┐
│ Claude Desktop   │  MCP    │ server.js (forwarder, no engine)         │
│  - replies       │ ──────▶ │  - sees port 48329 busy → delegates      │
│  - skill         │         │  - HTTP-forwards speak/stop/pause/...    │
│    voice-output  │         └──────────────────────────────────────────┘
└──────────────────┘                          │
                                              │ HTTP 127.0.0.1:48329
                                              ▼
┌──────────────────┐         ┌──────────────────────────────────────────┐
│ AutoHotkey       │ HTTP    │ server.js (HTTP owner, holds engine)     │
│ hotkey script    │ ──────▶ │  - autostarts at logon via Task Scheduler│
│  Ctrl+Alt+Z/A/.. │         │  - spawns tts-engine.ps1 (SAPI Speech)   │
└──────────────────┘         └──────────────────────────────────────────┘
                                              │
                                              ▼
                                      ┌────────────────┐
                                      │ tts-engine.ps1 │
                                      │  SAPI Speak    │
                                      └────────────────┘
                                              │
                                              ▼
                                       🔊 Speakers
```

**Key idea**: only one instance owns the audio engine. Every other instance (e.g. Claude Desktop's MCP spawn) auto-detects this via `EADDRINUSE` and switches to forwarder mode. This solves the "MCP speaks but hotkeys don't pause it" mismatch.

Detailed write-up: [`docs/architecture.md`](docs/architecture.md).

---

## Repo layout

```
voice-claude-kenta4es/
├── plugin/                 # Cowork plugin sources (zipped into .plugin)
│   ├── .claude-plugin/plugin.json
│   ├── skills/voice-output/SKILL.md
│   ├── mcp/                # server.js, tts-engine.ps1, etc.
│   ├── hotkeys/            # claude-tts-hotkeys.ahk
│   ├── scripts/install.ps1
│   └── .mcp.json
├── standalone/             # Manual installer (no plugin wrapper)
├── docs/
│   ├── architecture.md
│   └── whisper-groq-setup.md
├── README.md
└── LICENSE
```

---

## Quick verify (5 commands)

After running the installer, open PowerShell and check the stack is alive:

```powershell
# 1. Server is up?
Invoke-WebRequest -Uri http://127.0.0.1:48329/ping -UseBasicParsing | Select -Expand Content
# Expected: PONG

# 2. Engine state?
Invoke-WebRequest -Uri http://127.0.0.1:48329/state -UseBasicParsing | Select -Expand Content
# Expected: Ready

# 3. Speak something (you should hear Dmitry)
Invoke-WebRequest -Uri http://127.0.0.1:48329/speak -Method POST -Body 'Тест озвучки прошёл успешно' -ContentType 'text/plain; charset=utf-8'
# Expected: Speaking 27 chars  (and you hear it)

# 4. AHK process alive?
Get-Process AutoHotkey64 -ErrorAction SilentlyContinue
# Expected: one row with a PID

# 5. Scheduled task registered?
Get-ScheduledTask -TaskName 'VoiceClaudeKenta4es' | Select TaskName, State
# Expected: VoiceClaudeKenta4es  Ready
```

If all 5 return expected output, the stack is fully operational. Press `Left Ctrl + Left Alt + Z` during step 3 — the speech pauses, the AHK tooltip says "Paused".

To verify Claude Desktop auto-speak: open any chat, send a short message ("привет"). Claude's reply should be read aloud automatically by the `voice-output` skill via the MCP `claude-tts.speak` tool — you hear Dmitry without needing to call anything manually.

---

## How it works (HTTP vs MCP)

Two entry points to the same engine — pick whichever fits your context.

### HTTP API (any app, any language)

The owner server.js exposes plain HTTP on `127.0.0.1:48329`. No auth, no SSL — it's localhost only. Use it from PowerShell, AutoHotkey, Python, browser bookmarklets, anything that can speak HTTP. This is how the AutoHotkey hotkeys drive the engine, and how third-party scripts can read documents aloud without touching Claude at all.

```powershell
# Speak arbitrary text
Invoke-WebRequest -Uri http://127.0.0.1:48329/speak -Method POST -Body 'любой текст на русском' -ContentType 'text/plain; charset=utf-8'

# Pause / resume the current speech
Invoke-WebRequest -Uri http://127.0.0.1:48329/toggle-pause -UseBasicParsing

# Switch voice
Invoke-WebRequest -Uri 'http://127.0.0.1:48329/voice-set?name=Svetlana' -UseBasicParsing
```

The HTTP path is **synchronous from the caller's view**: you get a short response (`Speaking N chars`) immediately, audio plays asynchronously on the speakers. Subsequent calls (pause, stop, voice change) operate on the currently-playing audio.

### MCP auto-speak (Claude Desktop replies)

When Claude Desktop launches, it spawns its own `server.js` as an MCP child via stdio. That child cannot bind port 48329 (the owner already has it), so it flips to **forwarder mode** — every MCP tool call (`speak`, `pause`, `stop`, `set_voice`, ...) is forwarded over HTTP to the owner server.

The `voice-output` skill is loaded automatically into Claude's context and instructs Claude to call `mcp__claude-tts__speak` as the **first** tool call of every reply, with the cleaned-up version of the text it's about to write. So:

1. You type a message to Claude.
2. Claude composes a reply internally.
3. Claude's first action is `speak(<clean text>)` — forwarded over HTTP to the owner — audio starts playing on your speakers.
4. Claude then streams the reply text into the chat window.

Net effect: voice opens **before** or **alongside** the text appearing, no manual action required. Pause / stop hotkeys reach the same engine because everything converges on the single owner instance.

The behavior is enforced by the skill description (`description` field in `SKILL.md`), which is included in Claude's system context whenever the plugin is active. If you don't want this behavior for a specific reply, just say "молча" or "без озвучки" in your message.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/ping` returns nothing / connection refused | Owner server didn't start | `Get-ScheduledTask 'VoiceClaudeKenta4es'` — state should be Ready. Then `Start-ScheduledTask -TaskName 'VoiceClaudeKenta4es'`. Check `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` lists at least one server.js |
| `speak` returns `Speaking N chars` but you hear nothing | System mute (Ctrl+Alt+C toggled it) or wrong audio output device | Check the speaker icon in tray — un-mute if X is shown. Verify Windows default playback device |
| `speak` works but pause does nothing | Two server.js instances split between MCP and HTTP (architecture mismatch) | Kill all `node.exe` with `*server.js*`, restart Claude Desktop. Owner re-elects on first listen. This was the root bug the architecture fixes |
| Whisper transcribes "you", "Thank you", random English | Auto-detect picks EN on near-silence | Set OpenWhispr language to Russian explicitly (see `docs/whisper-groq-setup.md`) |
| AHK hotkey tooltip appears but speech keeps going | Engine ignored pause (rare on OneCore voices; usually means mismatch from previous issue) | Same fix as above — kill duplicate node, restart |
| `Voice not found: "Svetlana"` | Voice not installed | Windows Settings → Time & Language → Speech → Add voices → Russian, pick Svetlana / Dmitry |
| AHK doesn't load at startup | Startup folder script blocked by SmartScreen | Right-click `claude-tts-hotkeys.ahk` → Properties → Unblock |
| Claude Desktop replies arrive but no voice | Skill not loaded, or MCP not connected | Verify `mcp__claude-tts__speak` tool is in Claude's tool list (ask Claude "list your tools"). Restart Claude Desktop |

## Tags / keywords

`tts` · `stt` · `voice` · `speech` · `sapi` · `whisper` · `groq` · `windows` · `autohotkey` · `claude-desktop` · `mcp` · `russian` · `accessibility` · `dictation`

---

## License

MIT. See [`LICENSE`](LICENSE).

## Authors

**Kenta4es** — vision, requirements, testing, repository owner
**Claude** (Anthropic) — implementation, architecture, debugging, packaging

Built together during a single long Cowork session. The whole stack — MCP server, single-instance HTTP delegation pattern, skill, hotkeys, autostart — was iterated live, including the architectural fix where MCP `speak` and HTTP control hotkeys had been hitting two separate engine instances.

---

## Future ideas

- "Read selected text" hotkey for Word Desktop (via Word COM automation)
- Browser extension for reading selections on any web page (incl. Telegram Web, Office Online)
- English voice presets and quick-switch hotkey
- Visual rich tooltip with currently-spoken word position
