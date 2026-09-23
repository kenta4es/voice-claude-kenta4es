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
| `A` | mute / unmute the voice (remembers the volume) |
| `=` (`+`) / `-`, also numpad `+` / `-` | voice volume +10 / −10 |

Mention `A` too — people want silence at night without closing anything.
Verify volume with `GET /volume-state` → `{"saved":..,"lastVolume":..,"engine":..}`;
`engine` is what SAPI actually uses and must equal `saved`.

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

## 5. Dictation — install it, don't just mention it

**Offer this proactively.** The user very likely does not know they need a
separate app to dictate. Do not skip this section because "it's optional" —
ask once whether they want to talk instead of type, and if yes, install it for
them. Do not just hand them a link and walk away.

Accounts and keys: the user creates every account and pastes every key
themselves. Never type their password or an API key; open the page, fill in
harmless onboarding questions, and tell them clearly when their action is
needed.

1. **Install OpenWhispr** — https://openwhispr.com (free, Windows installer).
   If it shows "Update Available", update first (tested on 1.10.2). For a
   per-machine install the in-app button silently fails; run
   `%LOCALAPPDATA%\open-whispr-updater\pending\OpenWhispr-Setup-*.exe` by
   hand and let the user accept the UAC prompt.
2. **Speech engine: Deepgram Nova-3** (default choice). Whisper appends
   invented phrases on pauses ("Продолжение следует", "и я могу") and no
   cloud API lets you switch that off; Deepgram does not do it. Free: $200
   credit, no card, never expires (~3 years of heavy dictation). The console
   shows "Credit: $200" — tell the user it is a prepaid balance, not a loan.
   - user signs up at https://console.deepgram.com/signup and creates a key
     (name `OpenWhispr`, expiry Never), copies it — shown once;
   - Settings → Speech-to-Text → Dictation → Cloud Providers → **Deepgram**
     → user pastes key → **add**;
   - **click the Nova-3 row until it says "Active"** — the tab alone does
     not switch dictation over;
   - **restart OpenWhispr** — otherwise the dictation window never sees the
     key and fails with `No deepgram API key configured`;
   - **set the language**: `powershell -ExecutionPolicy Bypass -File
     tools\openwhispr-set-language.ps1 -Lang ru`. OpenWhispr has no language
     setting after onboarding; without it Nova-3 writes Russian speech as
     English words.
   Verify in `%APPDATA%\open-whispr\transcriptions.db` (copy it together with
   its `-wal` file): new rows must show `provider=deepgram-streaming`,
   `model=nova-3` and Russian `raw_text`.
   Weak PC? Do not offer local models (Parakeet/Whisper) on a 2-core CPU —
   25–45 s per minute of speech with the CPU pinned.
   Fallback engine: Groq **Whisper Large v3** (not Turbo), key from
   https://console.groq.com — see `docs/whisper-groq-setup.md` §3b.
3. **Groq key anyway** — https://console.groq.com → *API Keys*. The
   punctuation pass below runs on Groq's free tier.
4. **Set the dictation hotkey** (Settings → Hotkeys) and make sure it does not
   collide with the voice hotkeys from §3.
5. **Check the microphone** — Settings → Preferences → Input Device. Pick the
   real microphone explicitly rather than "Default". Have the user say a test
   phrase and confirm the transcript matches.

Then apply these settings — each one prevents a real failure we hit:

- **Punctuation = Dictation Cleanup with a strong model and a strict prompt.**
  Settings → Language Models → Dictation Cleanup: *Enable text cleanup* ON,
  Cloud Providers → **Groq** → **GPT-OSS 120B**, *Disable thinking output* ON.
  Prompt Studio → Customize → replace the prompt with
  `docs/openwhispr-cleanup-prompt.txt` → Save → verify in the *Test* tab with
  an unpunctuated question. Never use a small model (Llama 8B, GPT-OSS 20B):
  small models *answer the user's question* instead of punctuating it, or leak
  `<|python_tag|>` tokens. Full walkthrough: `docs/whisper-groq-setup.md` §4.
- **Turn OFF "Auto-learn from corrections"** (Settings → Preferences). It feeds
  words from bad transcripts back into the dictionary — a self-reinforcing loop.
- **Dictionary.** With Deepgram it becomes *keyterms*: a recognition boost, not
  a prompt, so it does not leak into pauses. Add only names/terms it gets
  wrong (20–50), spelled exactly as they should appear (`СДЭК` Cyrillic,
  `Bybit` Latin — Deepgram keeps the spelling). With Whisper the dictionary
  *is* the prompt and leaks on unclear audio — keep it tiny or empty.
- Do **not** put sample phrases into the dictionary to "teach" punctuation — it
  leaks into transcripts on unclear audio. Punctuation comes from the cleanup
  pass above.

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
| Transcript answers the question instead of transcribing | Cleanup runs on a weak model / default prompt | GPT-OSS 120B + strict prompt (§5) |
| Dictation has no punctuation or question marks | Cleanup off, or Whisper Turbo | Large v3 + cleanup with the strict prompt (§5) |
| Invented words at the end of dictation | Whisper hallucination on pauses | Switch to Deepgram Nova-3 (§5) |
| Russian speech comes out as English words | Language "auto" → Nova-3 assumes English | `tools/openwhispr-set-language.ps1 -Lang ru` |
| `No deepgram API key configured`, key visible in Settings | Dictation window started before the key was added | Restart OpenWhispr |
| Still Whisper in history after choosing Deepgram | Nova-3 row not activated | Click it until "Active" |

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
