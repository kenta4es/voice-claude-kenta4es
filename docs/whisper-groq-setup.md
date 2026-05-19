# Voice Dictation Setup — OpenWhispr + Groq Whisper

Voice **input** (dictation) is independent of the TTS plugin. Pick any STT app you like — this guide uses [OpenWhispr](https://openwhispr.com/) because it's free, open-source, and integrates with cloud Whisper providers via BYOK (bring your own key).

## 1. Install OpenWhispr

Download from https://openwhispr.com/ — Windows installer. Default install location: `D:\Program Files\OpenWhispr\` (or wherever you point it).

## 2. Get a Groq API key (free tier)

1. Go to https://console.groq.com/ → sign up.
2. **API Keys** → **Create API Key**. Copy it (starts with `gsk_...`).

Groq's free tier gives you **Whisper Large v3 Turbo** at ~216× real-time speed for free, with generous monthly limits. As of 2026 this is the fastest hosted Whisper available.

## 3. Configure OpenWhispr

Open OpenWhispr → Settings:

1. **Speech-to-Text** (left sidebar) → **Cloud Providers** (set Active).
2. Provider tab: **Groq**.
3. **API Key** field: paste your `gsk_...` key.
4. **Model**: select **Whisper Large v3 Turbo**.
5. **Preferences** → scroll up to **Language** setting → select **Russian** (this kills the "you" / "Thank you" hallucinations Whisper produces on silence in auto-detect mode).
6. **Preferences** → **Microphone**:
   - Turn **OFF** "Prefer Built-in Microphone" on desktops (the option is meant for laptops with internal mics).
   - System default (your physical Realtek / USB mic) will be used.
7. (Optional) **Language Models** → set to Groq + LLaMA 3.3 70B if you want AI cleanup, or disable cleanup entirely if it produces "There is no text to clean up." noise on silent input.

## 4. Set a global hotkey

OpenWhispr → **Hotkeys** → bind a key combination to "Start/Stop Dictation". Recommended: `Ctrl + Win` (free on most keyboards, easy thumb chord).

## 5. Test

1. Open any text field (Telegram, browser address bar, Word, Claude Desktop chat input).
2. Press your dictation hotkey.
3. Speak in Russian or English.
4. Press the hotkey again to stop — transcribed text is inserted at the cursor.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Garbage like "you", "Thank you", "." | Whisper auto-detect picks English on silence | Set Language = Russian (step 5) |
| "There is no text to clean up." | LLM cleanup runs on empty Whisper output | Disable AI cleanup in Preferences or set a smarter cleanup prompt |
| No microphone detected | "Prefer Built-in Microphone" is ON on a desktop | Turn it OFF |
| Wrong mic captured | Voice Changer / virtual audio device hijacks default | Set system default mic in Windows Sound settings |

## Why this combo

- **OpenWhispr** is local UI + global hotkey + cloud STT relay. It does the audio capture, hotkey, VAD, and text insertion. It does not store your audio or transcripts unless you opt in.
- **Groq Whisper Large v3 Turbo** is currently the fastest and most accurate hosted Whisper, with a generous free tier. It runs the actual transcription.
- Latency: ~0.5–1.5 s from "stop dictating" to text appearing at cursor.
