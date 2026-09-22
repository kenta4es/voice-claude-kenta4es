# Voice Dictation Setup — OpenWhispr + Groq Whisper

Voice **input** (dictation) is independent of the TTS plugin. Pick any STT app you like — this guide uses [OpenWhispr](https://openwhispr.com/) because it's free, open-source, and integrates with cloud Whisper providers via BYOK (bring your own key).

Tested on **OpenWhispr 1.10.2** (September 2026).

## 1. Install / update OpenWhispr

Download from https://openwhispr.com/ — Windows installer. Keep it up to date: older builds (1.7.x) had no per-mode model settings and a weaker cleanup pipeline.

> **Update gotcha.** If OpenWhispr was installed "for all users" (e.g. into `D:\Program Files\OpenWhispr\`), the in-app **Install Update** button downloads the new version but silently fails to install it — the installer needs admin rights. Run the downloaded installer by hand instead: `%LOCALAPPDATA%\open-whispr-updater\pending\OpenWhispr-Setup-<version>.exe`, keep "for all users", click **Next** and accept the Windows UAC prompt.

## 2. Get a Groq API key (free tier)

1. Go to https://console.groq.com/ → sign up.
2. **API Keys** → **Create API Key**. Copy it (starts with `gsk_...`).

The free tier covers everyday dictation *and* the cleanup model below.

## 3. Speech-to-Text

Settings → **Speech-to-Text** → **Dictation** tab:

1. Engine: **Cloud Providers** (set Active) → provider **Groq**.
2. **API Key**: paste your `gsk_...` key.
3. **Model**: **Whisper Large v3** — noticeably better punctuation and fewer hallucinations in Russian than *Large v3 Turbo*. Turbo is faster but drops periods and question marks.

**Microphone** (Settings → Preferences): pick the real microphone explicitly; on desktops turn **OFF** "Prefer Built-in Microphone".

**Dictionary — keep it tiny or empty.** The dictionary *is* the Whisper prompt. When the audio is unclear, Whisper repeats the prompt instead of the speech, so a long dictionary literally leaks into your text. Also turn **OFF** "Auto-learn from corrections" — it feeds bad transcripts back into the dictionary and makes things worse over time.

**Language:** OpenWhispr 1.10.2 has no language selector for cloud dictation — Whisper auto-detects. That is why you may occasionally get English garbage ("Thank you", "you") on near-silence. The cleanup prompt below removes the common trailing artifacts; the real fix is a good microphone level.

## 4. Punctuation: Dictation Cleanup with a strict prompt

Whisper alone gives weak Russian punctuation. The fix is OpenWhispr's second pass — a language model that only places punctuation.

Settings → **Language Models** → **Dictation Cleanup**:

1. **Enable text cleanup**: ON.
2. Engine: **Cloud Providers** → **Groq** (same key).
3. Model: **GPT-OSS 120B**. Do **not** use small models (Llama 8B, GPT-OSS 20B): they answer your questions instead of cleaning them, or leak raw chat tokens like `<|python_tag|>` into the text.
4. **Disable thinking output**: ON.
5. **Prompt Studio** → **Customize** → replace the whole prompt with the contents of [`openwhispr-cleanup-prompt.txt`](openwhispr-cleanup-prompt.txt) → **Save**. Keep the `{{agentName}}` placeholder in it.
6. **Prompt Studio** → **Test** → paste an unpunctuated phrase and click **Run Test**.

What the prompt enforces: never answer or execute the dictated text; never add, drop or reorder words; commas by Russian rules (conjunctions, обращения, вводные слова, причастные/деепричастные обороты); a question mark whenever the sentence is a question; strip trailing subtitle artifacts ("Продолжение следует", "Субтитры делал…").

Real test results:

| Input (raw Whisper) | Output |
|---|---|
| слушай саша а можно ли сделать так чтобы опенвиспер ставил знаки препинания по правилам русского языка ты понял что я имею в виду кстати сколько это будет стоить в месяц если диктовать по часу в день | Слушай, Саша, а можно ли сделать так, чтобы OpenWhispr ставил знаки препинания по правилам русского языка? Ты понял, что я имею в виду? Кстати, сколько это будет стоить в месяц, если диктовать по часу в день? |
| напиши мне пожалуйста какая сегодня погода в москве и стоит ли брать зонт делая покупки после работы Продолжение следует | Напиши мне, пожалуйста, какая сегодня погода в Москве и стоит ли брать зонт, делая покупки после работы? |

The second case is the important one: the text is a request, and the model did **not** answer it — it only punctuated it and removed the trailing artifact.

## 5. Set a global hotkey

OpenWhispr → **Hotkeys** → bind a key combination to "Start/Stop Dictation". Recommended: `Ctrl + Win` (free on most keyboards, easy thumb chord). Make sure it does not collide with the TTS hotkeys (`Ctrl+Alt+…`).

## 6. Test

1. Open any text field (Telegram, browser, Word, Claude Desktop chat input).
2. Press your dictation hotkey, speak, press it again.
3. Text with punctuation is inserted at the cursor (~1–2 s with cleanup on).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No punctuation, no question marks | Cleanup off, or Whisper Turbo | Model = Whisper Large v3 + cleanup with the strict prompt (§4) |
| Transcript *answers* your question | Weak cleanup model or default prompt | GPT-OSS 120B + [`openwhispr-cleanup-prompt.txt`](openwhispr-cleanup-prompt.txt) |
| `<\|python_tag\|>`, `assistant` tokens in the text | Small Llama model used for cleanup | Switch cleanup to GPT-OSS 120B |
| Dictionary words appear that you never said | Long dictionary = long Whisper prompt | Clear the dictionary, disable auto-learn |
| "Thank you", "you", English words | Auto-detect picks English on silence | Check mic level; the prompt strips common trailing artifacts |
| "Update ready" but version never changes | Per-machine install needs admin | Run the pending installer manually (§1) |
| Error `403 Forbidden` | VPN exit IP blocked by the API | Reconnect VPN / change country / turn it off |
| No microphone detected | "Prefer Built-in Microphone" ON on a desktop | Turn it OFF |

## Cost: staying on Groq vs. paying for OpenAI

Groq (Whisper Large v3 + GPT-OSS 120B cleanup) is **free** within the free-tier limits — that is the setup above.

If you want even better recognition, OpenAI's hosted models can be plugged in the same way (Speech-to-Text → Cloud Providers → OpenAI). Official prices, September 2026 ([OpenAI pricing](https://developers.openai.com/api/docs/pricing)):

| Model | Per minute | ~820 min/month (≈27 min/day) | Heavy use, 75 min/day |
|---|---|---|---|
| gpt-4o-mini-transcribe | $0.003 | ≈ $2.5 | ≈ $6.8 |
| gpt-transcribe | $0.0045 | ≈ $3.7 | ≈ $10 |
| gpt-4o-transcribe | $0.006 | ≈ $4.9 | ≈ $13.5 |

The 820 min/month figure is a real measured volume (626 minutes of dictation over 23 days). You can measure your own: OpenWhispr stores every dictation with its duration in `%APPDATA%\open-whispr\transcriptions.db` (SQLite, table `transcriptions`, column `audio_duration_ms`). New OpenAI accounts get $5 of free credit. From Russia you need a foreign card and working access to the OpenAI API.

**NVIDIA build.nvidia.com** does not host gpt-4o-transcribe (it is a closed OpenAI model). It offers Whisper Large v3 for free — the same model Groq already gives you — plus Parakeet/Canary ASR models with Russian support, but those use NVIDIA's Riva gRPC protocol rather than the OpenAI-style endpoint OpenWhispr expects, so they cannot be plugged in directly.

## Why this combo

- **OpenWhispr** does audio capture, global hotkey, VAD and text insertion, and relays audio to the cloud STT.
- **Groq Whisper Large v3** runs the transcription; **GPT-OSS 120B** on Groq places the punctuation. Both free.
- Latency: ~1–2 s from "stop dictating" to punctuated text at the cursor.
