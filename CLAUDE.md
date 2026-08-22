# Instructions for Claude — install this stack end to end

**Read this file completely before touching anything.** You are installing a
voice stack on a Windows machine for a non-technical user. Explain each step in
plain language, run the commands yourself, and verify after every stage instead
of assuming success.

Русский — читай так же внимательно: ты ставишь голосовой стек обычному
пользователю. Объясняй простыми словами, команды выполняй сам, после каждого
этапа проверяй результат, а не предполагай, что всё прошло.

---

## 0. What you are installing

Three independent pieces. Install them in this order; each works without the
next one.

| Piece | Gives the user | Required? |
|---|---|---|
| TTS server + engine (`plugin/mcp/`) | Claude reads replies aloud; any app can speak via local HTTP | **yes** |
| Hotkeys (`plugin/hotkeys/`) | Speak selection / pause / stop / restart in any window | strongly recommended |
| Dictation (OpenWhispr + Groq) | User dictates instead of typing | optional |

Everything is local. The only outbound traffic is to the voice service (for
neural voices) and to Groq (for dictation).

---

## 1. Prerequisites — check, don't assume

Run these and report what is missing before installing anything:

```powershell
node --version                                    # need Node.js LTS
Get-Command AutoHotkey64.exe -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Speech
(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() |
  Where-Object Enabled | ForEach-Object { $_.VoiceInfo.Name + ' [' + $_.VoiceInfo.Culture + ']' }
```

- **No Node.js** → https://nodejs.org (LTS). Everything else depends on it.
- **No AutoHotkey v2** → https://www.autohotkey.com. Without it there are no
  hotkeys, but the server still works.
- **No Russian voice in the list** → Windows Settings → Time & Language →
  Speech → Add voices → Russian.

---

## 2. Install the server

1. Copy `plugin/mcp/` to a stable path — `C:\ClaudeTTS` is the tested default.
2. Autostart at logon: register `start-tts-hidden.vbs` as a Scheduled Task
   (trigger: at logon, **delay ~30 s** so the network is up first).
3. Start it once by hand and verify:

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:48329/ping  -UseBasicParsing | Select -Expand Content   # PONG
Invoke-WebRequest -Uri http://127.0.0.1:48329/state -UseBasicParsing | Select -Expand Content   # Ready
```

4. **Pick a voice that actually produces audio — verify, don't trust the name.**
   A voice can be installed, selectable, report `Speaking`, and still emit
   silence (see CHANGELOG, "Known issue: Dmitry"). Test candidates by writing to
   a WAV file: a ~46-byte file means no audio.

```powershell
Add-Type -AssemblyName System.Speech
foreach ($v in 'Microsoft Svetlana Online','Microsoft Irina Desktop') {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $s.SelectVoice($v) } catch { "$v : NOT INSTALLED"; continue }
  $f = "$env:TEMP\vt.wav"; Remove-Item $f -EA SilentlyContinue
  $s.SetOutputToWaveFile($f); $s.Speak('Проверка'); $s.Dispose()
  "$v : $((Get-Item $f).Length) bytes"      # 46 = silence, >100000 = OK
}
```

   Write the winner into `voice.txt` (just the distinctive part, e.g.
   `Svetlana`). Every script reads that file.

---

## 3. Install the hotkeys

Copy `plugin/hotkeys/claude-tts-hotkeys.ahk` into the user's Startup folder
(`shell:startup`), then launch it. Validate before running:

```powershell
& 'C:\Program Files (x86)\AutoHotkey\v2\AutoHotkey64.exe' /validate "<path>\claude-tts-hotkeys.ahk"   # exit code 0
```

Layout — **Left** Ctrl + **Left** Alt + key (physical scan codes, so the
keyboard language does not matter):

| Key | Action |
|---|---|
| `Z` | speak the selected text |
| `X` | pause / resume |
| `C` | stop |
| `R` | restart the engine and recover sound |
| `↑` / `↓` | speech rate up / down |
| `→` / `←` | next / previous voice |

Tell the user about `R` explicitly: **if sound ever disappears, press
Ctrl+Alt+R first.** It fixes almost everything by itself.

---

## 4. Connect Claude Desktop (auto-speak)

Add the MCP server to `claude_desktop_config.json`, or install the Cowork plugin
from Releases. Then load the `voice-output` skill so Claude calls `speak` as the
first action of every reply.

**Critical:** if the user keeps a personal preference about voice, it must agree
with the skill. A preference like *"speak at the end"* overrides the skill and
breaks speak-before-text.

Verify: send Claude a short message and confirm the reply is spoken without any
manual action.

---

## 5. Dictation (optional)

Follow `docs/whisper-groq-setup.md`. Then apply these settings — each one
prevents a real failure we hit:

- **Turn OFF "Enable text cleanup"** (Settings → Language Models). It sends the
  transcript through a second model, which sometimes *answers the user's
  question* or rewrites their words instead of just cleaning punctuation.
- **Turn OFF "Auto-learn from corrections"** (Settings → Preferences). It feeds
  words from bad transcripts back into the dictionary, which grows the Whisper
  prompt, which produces worse transcripts — a self-reinforcing loop.
- **Keep the dictionary tiny** — names and technical terms only. The dictionary
  *is* the Whisper prompt: when the audio is unclear, Whisper repeats the prompt
  instead of the speech, so a long dictionary literally leaks into the text.
- Optional, for punctuation: add ONE short sample phrase such as
  `Хорошо. Понял, сделаю. А что дальше?` — Whisper imitates the style of the
  prompt. Keep it short for the same reason as above.

---

## 6. Diagnose by symptom — do not guess

| What the user sees | What it actually is | Fix |
|---|---|---|
| Server says `Speaking`, no sound | Voice produces no audio, or output device changed | WAV test from §2; press `Ctrl+Alt+R` |
| Nothing at all, `/ping` fails | Server process died | Run `tts-restart.ps1` (that is what `R` does) |
| Sound works right after `R`, then stops | The chosen voice is unreliable — usually a cloud voice | Switch `voice.txt` to a verified voice |
| Claude's replies silent, hotkeys fine | MCP link down, or the model skipped `speak` | Restart Claude Desktop; check the skill is loaded |
| Dictation returns "Thank you" or dictionary words | Microphone captured silence | Check mic level/connection, then re-record |
| Dictation error `403 Forbidden` | VPN exit IP blocked by the API | Reconnect VPN, change country, or turn it off |
| Dictation error `Failed to fetch` | Network dropped mid-request | Just retry |
| Transcript answers the question instead of transcribing | "Enable text cleanup" is on | Turn it off (§5) |

Useful one-liner to check whether audio reaches the speakers at all — this
bypasses the whole stack:

```powershell
(New-Object System.Media.SoundPlayer "$env:windir\Media\Windows Ding.wav").PlaySync()
```

If the user hears that but not the TTS, the problem is the voice or the engine —
not Windows audio.

---

## 7. Finish properly

Do not report success until you have personally confirmed:

1. `/ping` → `PONG`, `/state` → `Ready`
2. A test phrase was **heard by the user** (ask them — you cannot hear it)
3. `Ctrl+Alt+Z` reads a selected fragment
4. `Ctrl+Alt+X` pauses it, `Ctrl+Alt+C` stops it
5. A Claude reply is spoken automatically

Then tell the user, in one short message: which voice is active, the five
hotkeys, and the single rule — *"if it goes silent, press Ctrl+Alt+R."*

---

## Rules while working

- **Never mass-kill `node.exe` processes matching `server.js`.** Claude Desktop
  runs its MCP server the same way; killing everything disconnects Claude and
  only a restart of the app brings it back. Kill the owner of port 48329 only.
- Write `.ps1` files **ASCII-only** or with a UTF-8 BOM. Windows PowerShell 5.1
  reads BOM-less UTF-8 as ANSI and Cyrillic inside the script breaks the parser.
  Keep Russian text in separate `.txt` files and send it as raw bytes.
- After changing any script, validate it (`node --check`, `AutoHotkey /validate`)
  **before** telling the user it is ready.
