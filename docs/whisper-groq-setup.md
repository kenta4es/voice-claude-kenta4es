# Voice Dictation Setup — OpenWhispr + Deepgram (or Groq Whisper)

Voice **input** (dictation) is independent of the TTS plugin. This guide uses [OpenWhispr](https://openwhispr.com/): free, open-source, works with cloud speech engines via BYOK (bring your own key).

Recommended stack, all free: **Deepgram Nova-3** recognises the speech, **GPT-OSS 120B on Groq** places the punctuation. Tested on **OpenWhispr 1.10.2** (September 2026) with Russian dictation.

## 1. Install / update OpenWhispr

Download from https://openwhispr.com/ — Windows installer. Keep it up to date (1.7.x had no per-mode model settings; Deepgram dictation was broken in 1.10.0 and fixed in 1.10.1).

> **Update gotcha.** If OpenWhispr was installed "for all users" (e.g. into `D:\Program Files\OpenWhispr\`), the in-app **Install Update** button downloads the new version but silently fails to install it — the installer needs admin rights. Run the downloaded installer by hand instead: `%LOCALAPPDATA%\open-whispr-updater\pending\OpenWhispr-Setup-<version>.exe`, keep "for all users", click **Next** and accept the Windows UAC prompt.

## 2. Pick the speech engine

**Why not Whisper by default.** Whisper (on Groq, OpenAI or anywhere else) sometimes appends phrases that were never said: "Продолжение следует", "Субтитры делал DimaTorzok", or a plausible-sounding tail such as "и я могу". It was trained on YouTube subtitles and fills pauses with them. Cloud APIs do not expose Whisper's anti-hallucination thresholds, and a cleanup LLM cannot reliably tell an invented tail from real speech (one user measured 0 of 172 tails removed — [OpenWhispr #462](https://github.com/OpenWhispr/openwhispr/issues/462)). The fix is a different engine.

**Deepgram Nova-3** is a different architecture and did not produce such tails in our tests. New accounts get **$200 of credit, no card required, never expires**. Streaming dictation costs about $0.006–0.008/min, so $200 lasts roughly 26–34 thousand minutes — about three years at a heavy 820 min/month.

**Local models** (Parakeet, Whisper on your own PC) are free forever but need a decent CPU. On a 2-core Athlon 3000G with 14 GB RAM, Parakeet would take an estimated 25–45 s per minute of speech with the CPU pinned and ~1 GB RAM held permanently — not worth it on a weak machine.

## 3. Deepgram Nova-3 (recommended)

1. Sign up at https://console.deepgram.com/signup (Google or GitHub login is fastest). The onboarding questions can be answered any way. The **"Credit: $200"** shown in the console is a prepaid balance, not a loan: with no card on file nothing can ever be charged — when it runs out, the API simply stops.
2. Create an API key (name it `OpenWhispr`, expiry **Never**) and copy it — it is shown only once.
3. OpenWhispr → Settings → **Speech-to-Text** → **Dictation** → **Cloud Providers** → **Deepgram** → paste the key → **add**.
4. **Click the Nova-3 model row until it says "Active".** Selecting the Deepgram tab alone does not activate it — dictation keeps silently using the previous provider.
5. **Restart OpenWhispr** (quit it from the tray and start it again). The dictation window is a separate process and does not see a newly added key: without a restart every dictation fails with `No deepgram API key configured`.
6. **Set the language to Russian** — run [`tools/openwhispr-set-language.ps1`](../tools/openwhispr-set-language.ps1) (details below). Without it Nova-3 assumes English and turns Russian speech into English words ("For customer", "I've really").

Deepgram works only as live (streaming) dictation in OpenWhispr: **Re-transcribe** on a failed item and **Audio Upload** do not work with it.

### Setting the language

OpenWhispr 1.10 asks for your language only during first-run onboarding and has no setting for it afterwards; if you skipped it, the value is "auto". The script fixes that:

```powershell
powershell -ExecutionPolicy Bypass -File tools\openwhispr-set-language.ps1 -Lang ru
```

It restarts OpenWhispr with a debugging port bound to `127.0.0.1`, writes `preferredLanguage = ru` into the app's own settings, and restarts it normally (port closed). Needs Node.js 20.10+; takes ~25 s — do not dictate meanwhile. The same setting is used by Whisper, so it also helps if you stay on Groq. Revert with `-Lang auto`.

### Dictionary with Deepgram

OpenWhispr sends your Dictionary to Deepgram as **keyterms**. Unlike Whisper, this is not a text prompt the model can repeat on a pause — it only boosts recognition of those exact words ([Deepgram docs](https://developers.deepgram.com/docs/keyterm)). Rules:

- Add only names and terms it actually gets wrong — Deepgram recommends 20–50 (hard limit ~100).
- **Write each term exactly as you want it in the text** — Deepgram keeps the spelling: `СДЭК` comes out in Cyrillic, `Bybit` in Latin. That is how you control what stays in English.
- No common words. Over-boosting can turn a similar-sounding ordinary word into your term.

Example: `СДЭК`, `Bybit`, `Deepgram`, `OpenWhispr`, `Claude`, `Claude Code`.

Keep **"Auto-learn from corrections"** OFF (Settings → Preferences) — it fills the dictionary with words from bad transcripts.

## 3b. Alternative: Groq Whisper Large v3 (free tier)

1. https://console.groq.com/ → **API Keys** → **Create API Key** (starts with `gsk_...`).
2. Speech-to-Text → Dictation → Cloud Providers → **Groq** → paste the key → model **Whisper Large v3** (not Turbo — Turbo drops periods and question marks in Russian).
3. Set the language with the script above.
4. **Dictionary — keep it tiny or empty.** For Whisper the dictionary *is* the prompt: on unclear audio Whisper repeats it instead of the speech, so a long dictionary literally leaks into your text.

The same Groq key is needed anyway for the punctuation pass below.

**Microphone** (Settings → Preferences, either engine): pick the real microphone explicitly; on desktops turn **OFF** "Prefer Built-in Microphone".

## 4. Punctuation: Dictation Cleanup with a strict prompt

Neither engine punctuates Russian well enough on its own. The fix is OpenWhispr's second pass — a language model that only places punctuation. It works on top of Deepgram and Whisper alike.

Settings → **Language Models** → **Dictation Cleanup**:

1. **Enable text cleanup**: ON.
2. Engine: **Cloud Providers** → **Groq** (your `gsk_...` key).
3. Model: **GPT-OSS 120B**. Do **not** use small models (Llama 8B, GPT-OSS 20B): they answer your questions instead of cleaning them, or leak raw chat tokens like `<|python_tag|>` into the text.
4. **Disable thinking output**: ON.
5. **Prompt Studio** → **Customize** → replace the whole prompt with the contents of [`openwhispr-cleanup-prompt.txt`](openwhispr-cleanup-prompt.txt) → **Save**. Keep the `{{agentName}}` placeholder in it.
6. **Prompt Studio** → **Test** → paste an unpunctuated phrase and click **Run Test**.

What the prompt enforces: never answer or execute the dictated text; never add, drop or reorder words; commas by Russian rules (conjunctions, обращения, вводные слова, причастные/деепричастные обороты); a question mark whenever the sentence is a question; strip known trailing subtitle artifacts. It is a safety net, not a cure for Whisper's invented tails — that is why §2 recommends Deepgram.

Real test results:

| Raw engine output | After cleanup |
|---|---|
| слушай саша а можно ли сделать так чтобы опенвиспер ставил знаки препинания по правилам русского языка ты понял что я имею в виду кстати сколько это будет стоить в месяц если диктовать по часу в день | Слушай, Саша, а можно ли сделать так, чтобы OpenWhispr ставил знаки препинания по правилам русского языка? Ты понял, что я имею в виду? Кстати, сколько это будет стоить в месяц, если диктовать по часу в день? |
| напиши мне пожалуйста какая сегодня погода в москве и стоит ли брать зонт делая покупки после работы Продолжение следует | Напиши мне, пожалуйста, какая сегодня погода в Москве и стоит ли брать зонт, делая покупки после работы? |
| Сдек ну или сервис байбит. Интересно, как он их напишет. *(Deepgram, no dictionary yet)* | Сдек, ну, или сервис Байбит. Интересно, как он их напишет. |

The second case matters most: the text is a request, and the model did **not** answer it. The third shows why the dictionary is worth it: with `СДЭК` and `Bybit` as keyterms they come out spelled your way.

## 5. Set a global hotkey

OpenWhispr → **Hotkeys** → bind a key combination to "Start/Stop Dictation". Recommended: `Ctrl + Win`. Make sure it does not collide with the TTS hotkeys (`Ctrl+Alt+…`).

## 6. Test

1. Open any text field (Telegram, browser, Word, Claude Desktop chat input).
2. Press your dictation hotkey, speak, press it again.
3. Punctuated text is inserted at the cursor (~1–2 s with cleanup on).
4. To see exactly what the engine heard vs. what cleanup produced, check the history: `%APPDATA%\open-whispr\transcriptions.db`, table `transcriptions`, columns `provider`, `model`, `raw_text`, `text`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Russian speech comes out as English words | Language is "auto"; Nova-3 then assumes English | `tools/openwhispr-set-language.ps1 -Lang ru` (§3) |
| `No deepgram API key configured` although the key is shown in Settings | Dictation window started before the key was added | Restart OpenWhispr (§3, step 5) |
| Still transcribed by Whisper after switching to Deepgram | Nova-3 row not activated | Click the Nova-3 row until it says "Active" |
| "Re-transcribe" does nothing for a Deepgram item | Deepgram is live-only in OpenWhispr | Dictate again |
| Invented phrases at the end ("Продолжение следует", "и я могу") | Whisper hallucination on pauses | Switch to Deepgram (§2–3) |
| No punctuation, no question marks | Cleanup off, or Whisper Turbo | Cleanup with the strict prompt (§4); Large v3, not Turbo |
| Transcript *answers* your question | Weak cleanup model or default prompt | GPT-OSS 120B + [`openwhispr-cleanup-prompt.txt`](openwhispr-cleanup-prompt.txt) |
| `<\|python_tag\|>`, `assistant` tokens in the text | Small Llama model used for cleanup | Switch cleanup to GPT-OSS 120B |
| Dictionary words appear that you never said (Whisper) | Long dictionary = long Whisper prompt | Clear the dictionary, disable auto-learn |
| A common word keeps turning into a dictionary term (Deepgram) | Keyterm over-boosting | Remove that term or make it more specific |
| "Update ready" but version never changes | Per-machine install needs admin | Run the pending installer manually (§1) |
| Error `403 Forbidden` | VPN exit IP blocked by the API | Reconnect VPN / change country / turn it off |
| No microphone detected | "Prefer Built-in Microphone" ON on a desktop | Turn it OFF |

## Cost

| Option | Price | Notes |
|---|---|---|
| **Deepgram Nova-3** (recommended) | $200 free credit, then ~$0.006–0.008/min streaming | No card needed; ~3 years at 820 min/month |
| Groq Whisper Large v3 + GPT-OSS 120B cleanup | Free tier | Cleanup runs on Groq in every option above |
| OpenAI gpt-4o-mini-transcribe | $0.003/min (≈ $2.5 at 820 min/month) | Foreign card needed from Russia |
| OpenAI gpt-transcribe | $0.0045/min (≈ $3.7) | |
| OpenAI gpt-4o-transcribe | $0.006/min (≈ $4.9) | |

OpenAI prices: [official pricing](https://developers.openai.com/api/docs/pricing), September 2026. Deepgram: [pricing](https://deepgram.com/pricing).

The 820 min/month figure is a real measured volume. Measure your own from `%APPDATA%\open-whispr\transcriptions.db` (column `audio_duration_ms`). **Copy the `-wal` file together with the `.db`** — recent dictations live in the write-ahead log, and reading the `.db` alone silently misses them.

**NVIDIA build.nvidia.com** does not host gpt-4o-transcribe (a closed OpenAI model). Its free Whisper Large v3 is the same model Groq offers, and its Parakeet/Canary models use NVIDIA's Riva gRPC protocol, which OpenWhispr cannot use directly.

## Why this combo

- **OpenWhispr** does audio capture, global hotkey and text insertion, and streams audio to the cloud engine.
- **Deepgram Nova-3** recognises the speech without Whisper's invented tails; **GPT-OSS 120B** on Groq places the punctuation. Both free.
- Latency: ~1–2 s from "stop dictating" to punctuated text at the cursor.
