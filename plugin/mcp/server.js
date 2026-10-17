#!/usr/bin/env node
// Claude TTS MCP Server v2
// Tools: speak, stop, pause, resume, toggle_pause, set_voice, set_rate, set_volume, list_voices, get_state
// Architecture: long-lived PowerShell child holds SAPI SpeechSynthesizer with SpeakAsync;
//               commands flow via stdin lines. HTTP endpoint on 127.0.0.1 for AutoHotkey hotkeys.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';

const PSDIR = 'C:\\ClaudeTTS';
mkdirSync(PSDIR, { recursive: true });

// ---------- state ----------
const STATE_FILE = join(tmpdir(), 'claude-tts-state.json');
const state = {
  voice: 'Microsoft Dmitry Online',
  rate: 1,
  volume: 100,
  lastVolume: 100, // volume to restore when un-muting (Ctrl+Alt+A)
  removePunctuationPauses: false,
};

try {
  if (existsSync(STATE_FILE)) {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    Object.assign(state, saved);
  }
} catch {}

function saveState() {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ---------- single-instance / HTTP delegation ----------
const HTTP_PORT = 48329;
let isHttpOwner = false; // set true once httpServer fires 'listening'

function forwardHttp(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: HTTP_PORT,
      path,
      method,
      timeout: 5000,
    };
    if (body != null) {
      opts.headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      };
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('forward timeout')));
    if (body != null) req.write(body);
    req.end();
  });
}

// Last-resort guard. This is a background service the user cannot see: dying
// quietly is the worst possible failure, because every hotkey and every reply
// goes silent with nothing left to report why. Stay alive and log instead.
process.on('uncaughtException', (e) => {
  try { console.error('[tts] uncaught: ' + (e && e.stack ? e.stack : e)); } catch {}
});
process.on('unhandledRejection', (e) => {
  try { console.error('[tts] unhandled rejection: ' + e); } catch {}
});

// ---------- long-lived PowerShell engine ----------
const enginePath = join(PSDIR, 'tts-engine.ps1');
let voiceOverride = null;        // set by the watchdog: voice for the replay after a hang
let onEngineRestored = null;     // called once the respawned engine has its voice applied
let engine = null;
let engineReady = false;
const pendingReplies = []; // queue of resolvers waiting for engine output

function startEngine() {
  engine = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', enginePath],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );

  // CRITICAL: without these, the death of the engine took the whole server with
  // it. Writing to the stdin of a dead child emits an async 'error' (EPIPE) on
  // the stream; an unhandled stream error is a fatal uncaught exception in
  // Node. Result: engine dies -> server dies -> no /ping, no /stop, no hotkeys,
  // total silence with nothing left to recover it. Swallow them instead; the
  // 'exit' handler respawns a fresh engine.
  engine.on('error', (e) => { try { console.error('[tts] engine error: ' + e.message); } catch {} });
  engine.stdin.on('error', () => {});
  engine.stdout.on('error', () => {});
  engine.stderr.on('error', () => {});

  let buf = '';
  engine.stdout.setEncoding('utf8');
  engine.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === 'READY') {
        engineReady = true;
      } else if (pendingReplies.length > 0) {
        const r = pendingReplies.shift();
        r(line);
      }
    }
  });

  engine.on('exit', () => {
    engineReady = false;
    pendingReplies.splice(0).forEach((r) => r('ENGINE_EXIT'));
    // auto-restart after 1s, then re-apply the saved voice/rate/volume: a fresh
    // engine starts at SAPI defaults (volume 100), which would override a mute.
    setTimeout(async () => {
      startEngine();
      if (await waitReady(8000)) {
        await sendCmd(`VOLUME ${state.volume}`);
        await sendCmd(`RATE ${state.rate}`);
        // The watchdog may ask for a different voice for the replay (see watchdogTick).
        await sendCmd(`VOICE ${voiceOverride || state.voice}`);
        if (onEngineRestored) { const f = onEngineRestored; onEngineRestored = null; f(); }
      }
    }, 1000);
  });
}

// Every command now has a deadline. Without one, a wedged engine (a cloud voice
// stuck mid-request, a dead audio endpoint) left the HTTP request hanging
// forever: the hotkey's 2 s WinHttp timeout fired, nothing stopped, and Stop
// looked broken while speech kept playing.
function sendCmd(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!engine || !engineReady) {
      resolve('ENGINE_NOT_READY');
      return;
    }
    let done = false;
    let timer = null;
    const entry = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      // Keep the reply queue aligned: a late answer must not be handed to the
      // NEXT waiting command, so swap our slot for a no-op instead of removing.
      const i = pendingReplies.indexOf(entry);
      if (i !== -1) pendingReplies[i] = () => {};
      resolve('TIMEOUT');
    }, timeoutMs);
    pendingReplies.push(entry);
    try { engine.stdin.write(cmd + '\n'); }
    catch (e) { entry('WRITE_ERR'); }
  });
}

// Hard reset: killing the engine process also kills whatever it is playing, so
// this is the guaranteed way to shut the voice up. The 'exit' handler respawns
// a fresh engine one second later.
function restartEngine(reason) {
  try { console.error('[tts] restarting engine: ' + reason); } catch {}
  engineReady = false;
  try { if (engine) engine.kill(); } catch {}
}

// Stop that cannot fail. If the engine does not confirm quickly it is wedged,
// so we kill it — the user pressed Stop and must get silence either way.
async function stopSpeech() {
  // Edge voices: silence the browser engine too (cheap, harmless when unused).
  if (typeof edgePush === 'function') { edgeJobs.length = 0; edgePush({ type: 'stop' }); inflight.length = 0; }
  const r = await sendCmd('STOP', 1500);
  if (r === 'TIMEOUT' || r === 'ENGINE_NOT_READY' || r === 'WRITE_ERR') {
    restartEngine('stop did not respond (' + r + ')');
    return 'STOPPED (engine restarted)';
  }
  return r;
}

async function waitReady(timeoutMs = 5000) {
  const start = Date.now();
  while (!engineReady && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 50));
  }
  return engineReady;
}

// apply state on startup
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// TCP-connect probe to a public host — true if the network is reachable.
function internetUp(timeout = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const s = net.connect(443, '8.8.8.8');
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(v); } };
    s.setTimeout(timeout);
    s.on('connect', () => fin(true));
    s.on('timeout', () => fin(false));
    s.on('error', () => fin(false));
  });
}

async function applyState() {
  await waitReady();
  const desired = state.voice;
  // Do NOT auto-fallback to the offline voice any more. The internet probe
  // fails whenever the VPN is up, so the engine kept silently switching to
  // "Irina" on startup - the user would suddenly hear a different voice.
  // The preferred voice is applied as-is; if it ever misbehaves, Ctrl+Alt+R
  // restarts the engine.
  const isOnline = false;
  if (isOnline) {
    // Online (cloud) voices are silent without internet. At logon the engine can
    // start before the network is up, caching a "mute" voice. So wait for the
    // network first; if it never comes, fall back to an offline voice and keep
    // retrying to upgrade back to the desired online voice once we're online.
    let online = false;
    for (let i = 0; i < 20 && !online; i++) {
      online = await internetUp();
      if (!online) await sleep(3000);
    }
    if (online) {
      await sendCmd(`VOICE ${desired}`);
    } else {
      await sendCmd(`VOICE Microsoft Irina Desktop`);
      const timer = setInterval(async () => {
        if (await internetUp()) {
          clearInterval(timer);
          await sendCmd(`VOICE ${desired}`);
        }
      }, 10000);
    }
  } else {
    await sendCmd(`VOICE ${desired}`);
  }
  await sendCmd(`RATE ${state.rate}`);
  await sendCmd(`VOLUME ${state.volume}`);
}

// Engine + voiceList are started inside httpServer 'listening' event below.
// Non-owner instances skip engine to avoid SAPI state mismatch.

// ---------- helpers ----------
// Strip everything that is pointless or annoying to hear. Applied centrally so
// EVERY path benefits: MCP replies, the read-selection hotkey, the VS Code
// extension and any third-party caller. Reading a URL character by character is
// the classic offender; so are the tool-usage lines the chat UI renders
// ("Used Desktop Commander integration", "(3 actions) - 4 notes").
// A fenced block is read aloud only if it is human prose (a ready-to-send text,
// a quote) — mostly Cyrillic words, almost no code punctuation. Code, commands
// and configs inside ``` are still skipped.
function isProseBlock(body) {
  const b = String(body);
  const letters = (b.match(/[A-Za-zА-Яа-яЁё]/g) || []).length;
  const cyr = (b.match(/[А-Яа-яЁё]/g) || []).length;
  // "$" is NOT a code sign here: prices ("50 $") are common in human texts.
  const codeChars = (b.match(/[{}[\];=<>\\|]|\$[({A-Za-z_]/g) || []).length;
  if (letters < 3 || cyr < letters * 0.5) return false;
  return codeChars <= Math.max(1, b.length * 0.01);
}
function readableFences(t) {
  return String(t).replace(/```[^\n]*\n?([\s\S]*?)```/g, (m, body) => (isProseBlock(body) ? '\n' + body.trim() + '\n' : ' '));
}

function sanitizeForSpeech(input) {
  let t = String(input);
  t = readableFences(t);                                         // code blocks out, prose blocks kept
  // Emoji are decoration, not words: the Windows voice reads them by name
  // («земной шар», «зелёная галочка»). Remove pictographs, flags, skin tones,
  // keycap marks, variation selectors and joiners.
  t = t.replace(/\p{Extended_Pictographic}/gu, ' ');
  t = t.replace(/[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}\uFE0E\uFE0F\u200D\u20E3]/gu, '');
  t = t.replace(/^[ \t]*(?:used|using)\b[^\n]*$/gim, ' ');      // "Used X integration"
  t = t.replace(/\([^)]*\b(?:actions?|notes?|steps?)\b[^)]*\)/gi, ' ');
  t = t.replace(/[·•][^\n]*\b(?:actions?|notes?)\b/gi, ' ');
  t = t.replace(/\b(?:mcp__|tool_use|tool_result)\S*/g, ' ');   // tool names
  // Source / reference lists at the end of a reply
  t = t.replace(/\n[ \t]{0,3}#{0,6}[ \t]*(?:\*\*|__)?(?:источник[аиов]*|sources?|references?)(?:\*\*|__)?[ \t]*:?[ \t]*\n[\s\S]*$/i, '\n');
  t = t.replace(/\n[ \t]{0,3}#{0,6}[ \t]*(?:\*\*|__)?(?:источник[аиов]*|sources?|references?)(?:\*\*|__)?[ \t]*:[\s\S]*$/i, '\n');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');                  // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');                // [text](url) -> text
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' ');                     // full URLs
  t = t.replace(/\bwww\.\S+/gi, ' ');
  t = t.replace(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|ru|org|net|io|ai|dev|me|app|co|edu|gov|info|xyz)\b(?:\/\S*)?/gi, ' ');
  t = t.replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ');                 // markdown tables: not read aloud
  t = t.replace(/[A-Za-z]:[\\/][^\n\])"]*/g, ' ');              // windows paths, spaces included
  t = t.replace(/`([^`]+)`/g, '$1');                            // inline code marks
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// Every speak request is logged (time, size, start of text) so voicing can be
// verified from the log instead of by ear.
const SPEAK_LOG = join(PSDIR, 'speak.log');
function logSpeak(raw, payload, queue, mark) {
  try {
    const head = String(payload || raw).replace(/\s+/g, ' ').slice(0, 70);
    appendFileSync(SPEAK_LOG, `${new Date().toISOString()} ${mark || (queue ? 'Q' : 'N')} in=${String(raw).length} out=${String(payload).length} | ${head}\n`);
  } catch {}
}

// ---- One voice per chat -------------------------------------------------------
// In LOCAL Cowork chats the tts-watch backstop reads the final answer verbatim
// from the screen. If Claude also calls speak there (usually with a shortened
// retelling), the user hears the answer twice. The watcher sees Claude's speak
// call in the chat log 2-5 s BEFORE the call reaches this server and registers
// its text via POST /suppress. Every speak that does not come from the watcher
// is held HOLD_MS, then dropped if it was registered. Cloud chats have no local
// log, nothing registers them, so Claude's own speak plays there (1.5 s later).
const HOLD_MS = 1500;
const SUPPRESS_TTL_MS = 5 * 60 * 1000;
const suppressed = new Map();   // key -> expiry
const playedModel = new Map();  // key -> expiry (model speech already played)
function speechKey(t) {
  return String(t).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '').slice(0, 300);
}
function prune(m) { const now = Date.now(); for (const [k, exp] of m) if (exp < now) m.delete(k); }
// Returns 'OK' (will be dropped) or 'PLAYED' (too late, already spoken).
function registerSuppress(text) {
  prune(suppressed); prune(playedModel);
  const k = speechKey(text);
  if (!k) return 'EMPTY';
  if (playedModel.has(k)) return 'PLAYED';
  suppressed.set(k, Date.now() + SUPPRESS_TTL_MS);
  return 'OK';
}
function speakFromModel(text, queue = false) {
  setTimeout(() => {
    const k = speechKey(text);
    if (k && suppressed.has(k)) {
      suppressed.delete(k);
      logSpeak(text, '', queue, 'S');   // S = skipped: local chat, the watcher reads the screen
      return;
    }
    if (k) playedModel.set(k, Date.now() + SUPPRESS_TTL_MS);
    speakAsync(text, queue);
  }, HOLD_MS);
}

function speakAsync(text, queue = false) {
  let payload = sanitizeForSpeech(text);
  logSpeak(text, payload, queue);
  if (!payload) return Promise.resolve('EMPTY');
  if (state.removePunctuationPauses) payload = payload.replace(/\s+/g, ' ');
  inflight.push({ queue, payload });                 // remembered until the engine goes quiet
  countUsage(payload.length);
  if (useEdge()) return edgeSpeak(payload, queue);
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  return sendCmd(`${queue ? 'SPEAKQ' : 'SPEAK'} ${b64}`);
}

// ---------- monthly character counter (Azure free tier: 500 000 chars / month) ----------
// Counts every character actually sent to the speech engine in the current calendar
// month (usage.json next to the server). At USAGE_WARN and USAGE_LIMIT it says so out
// loud once, so the user can decide in time whether to switch to the paid tier.
// GET /usage shows the numbers.
const USAGE_FILE = join(PSDIR, 'usage.json');
const USAGE_WARN = 450000, USAGE_LIMIT = 500000;
// Spoken warnings only matter on a metered voice (Azure). With the free Edge voices
// the counter just counts; set to true if a paid/limited voice is used again.
const USAGE_NOTIFY = false;
let usage = { month: '', chars: 0, warned: false, limitSaid: false };
try { usage = Object.assign(usage, JSON.parse(readFileSync(USAGE_FILE, 'utf8'))); } catch {}
function monthKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function countUsage(n) {
  const m = monthKey();
  if (usage.month !== m) usage = { month: m, chars: 0, warned: false, limitSaid: false };
  usage.chars += n;
  let notice = '';
  if (!USAGE_NOTIFY) { try { writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2)); } catch {} return; }
  if (!usage.warned && usage.chars >= USAGE_WARN) {
    usage.warned = true;
    notice = `Внимание: в этом месяце озвучено уже ${Math.round(usage.chars / 1000)} тысяч символов из 500 бесплатных. Скоро бесплатный лимит закончится.`;
  } else if (!usage.limitSaid && usage.chars >= USAGE_LIMIT) {
    usage.limitSaid = true;
    notice = 'Бесплатный лимит озвучки на этот месяц исчерпан. Озвучка может замолчать до первого числа.';
  }
  try { writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2)); } catch {}
  if (notice) {
    try { appendFileSync(SPEAK_LOG, `${new Date().toISOString()} U ${notice}\n`); } catch {}
    setTimeout(() => { sendCmd(`SPEAKQ ${Buffer.from(notice, 'utf8').toString('base64')}`); }, 0);
  }
}

// ---------- Edge browser engine for the online voices ----------
// On 10.10.2026 Microsoft changed the protocol of its free Edge read-aloud service:
// third-party clients (NaturalVoiceSAPIAdapter -> "Microsoft Svetlana/Dmitry Online"
// in SAPI) get "Invalid HTTP status" and produce silence. The Edge browser itself
// still speaks these voices. So for them the server drives a hidden Edge window
// (edge-voice.html) that long-polls /edge/next for jobs and speaks with
// speechSynthesis. Offline voices (Irina, Pavel) still use the SAPI engine.
const EDGE_VOICES = { 'Microsoft Svetlana Online': 'svetlana', 'Microsoft Dmitry Online': 'dmitry' };
const EDGE_PROFILE = join(PSDIR, 'edge-voice-profile');
const EDGE_PAGE = join(PSDIR, 'edge-voice.html');
const EDGE_EXE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const edgeJobs = [];
const edgeWaiters = [];
const edgeStatus = { at: 0, speaking: false, pending: 0, paused: false, voices: false };
let lastEdgeSignal = 0, edgeLaunchedAt = 0;

// After Dmitry hangs silently, Svetlana speaks instead for EDGE_FALLBACK_MS, then
// Dmitry is tried again (the user's wish: Dmitry by default, Svetlana as backup).
const EDGE_FALLBACK_MS = 10 * 60 * 1000;
let edgeFallbackUntil = 0;
function edgeKey() {
  const k = EDGE_VOICES[state.voice] || null;
  if (k && k !== 'svetlana' && Date.now() < edgeFallbackUntil) return 'svetlana';
  return k;
}
function edgeAlive() { return Date.now() - edgeStatus.at < 4000; }
function useEdge() { return !!(EDGE_EXE && edgeKey()); }
function edgeBusy() { return edgeStatus.speaking || edgeStatus.pending > 0; }
function edgeRate() { return Math.max(0.5, Math.min(2, 1 + (state.rate || 0) * 0.08)); }

function edgePush(job) {
  edgeJobs.push(job);
  while (edgeWaiters.length) { const w = edgeWaiters.shift(); w(); }
}
function edgeSpeak(payload, queue) {
  edgePush({ type: 'speak', text: payload, queue, voice: edgeKey(), rate: edgeRate(), volume: (state.volume || 0) / 100 });
  return Promise.resolve('OK');
}
function edgeState() { return !edgeAlive() ? 'NOT_RUNNING' : edgeStatus.paused ? 'Paused' : edgeBusy() ? 'Speaking' : 'Ready'; }

function killEdgeVoice() {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*edge-voice-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, stdio: 'ignore' });
    p.on('exit', () => resolve()); p.on('error', () => resolve());
  });
}
async function launchEdgeVoice(reason) {
  if (!EDGE_EXE) return;
  edgeLaunchedAt = Date.now();
  wdLog('edge voice window start: ' + reason);
  await killEdgeVoice();
  const child = spawn(EDGE_EXE, [
    `--user-data-dir=${EDGE_PROFILE}`, `--app=http://127.0.0.1:${HTTP_PORT}/edge-voice`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
    '--window-position=-2400,-2400', '--window-size=360,200',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => wdLog('edge start error: ' + e.message));
  child.unref();
}
// Keep the Edge window alive while an Edge voice is selected.
// Never restart while the window is audibly speaking: a late poll is not worth cutting
// a sentence in half (that is what the user heard as "Dmitry breaks off mid-phrase").
function edgeSupervise() {
  if (!useEdge()) return;
  const now = Date.now();
  if (!edgeAlive() && now - edgeLaunchedAt > 15000 && now - edgeStatus.at > 15000 && now - lastEdgeSignal > 10000)
    launchEdgeVoice('no poll from the edge page');
}

// ---------- watchdog: "speaking" but no sound ----------
// The Microsoft *Online* voices (Svetlana, Dmitry) are synthesized in the cloud.
// Now and then the engine hangs: SAPI reports Speaking, nothing reaches the
// speakers, and only a manual Ctrl+Alt+R helped. meter-helper.ps1 reports the
// real output level of every audio session on the default device; if the engine
// says Speaking but its own session produces no signal for SILENT_MS, the engine
// is restarted and everything not yet spoken is said again. A second hang within
// 5 minutes replays with FALLBACK_VOICE (Svetlana, the user's preferred voice) if
// another voice was the one hanging; if Svetlana herself hangs, she is simply
// restarted again. More than MAX_RESTARTS in 5 minutes: give up quietly (no loop).
const SILENT_MS = 8000;               // silence after the voice has started speaking
const FIRST_SOUND_MS = 15000;         // wait for the first sound of a message
const EDGE_FIRST_SOUND_MS = 8000;     // the same for the Edge browser engine
const FALLBACK_VOICE = 'Microsoft Svetlana Online';
const MAX_RESTARTS = 3;
const COLD_START_MS = 10000;          // after a restart the first sound may take longer
let graceUntil = 0;
const inflight = [];                  // messages sent since the engine was last quiet
const lastSignal = new Map();         // pid -> time of last non-zero output peak
let meter = null, lastMeterTick = 0, speakingSince = 0, wdBusy = false, fallbackActive = false;
const autoRestarts = [];

function startMeter() {
  meter = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(PSDIR, 'meter-helper.ps1')],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  meter.on('error', () => {});
  meter.stdout.on('error', () => {});
  let buf = '';
  meter.stdout.setEncoding('utf8');
  meter.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('TICK')) continue;
      lastMeterTick = Date.now();
      for (const tok of line.split(' ').slice(1)) {
        const [p, v, name] = tok.split(':');
        if (parseFloat(v) > 0.01) {
          lastSignal.set(Number(p), Date.now());
          if (name === 'msedge') lastEdgeSignal = Date.now();
        }
      }
    }
  });
  meter.on('exit', () => { meter = null; setTimeout(startMeter, 5000); });
}

function wdLog(msg) {
  try { appendFileSync(SPEAK_LOG, `${new Date().toISOString()} W ${msg}\n`); } catch {}
}

async function watchdogTick() {
  if (wdBusy) return;
  wdBusy = true;
  try {
    const edge = useEdge();
    if (edge) edgeSupervise();
    if (!edge && (!engine || !engineReady)) { speakingSince = 0; return; }
    const st = edge ? edgeState() : await sendCmd('STATE', 1500);
    if (st === 'Ready') {
      inflight.length = 0;
      speakingSince = 0;
      if (fallbackActive && !edge) { fallbackActive = false; await sendCmd(`VOICE ${state.voice}`); }
      return;
    }
    // An engine that does not even answer STATE while it has work is wedged too
    // (for Edge: the page stopped polling).
    const now = Date.now();
    if ((st === 'TIMEOUT' || st === 'NOT_RUNNING') && inflight.length && state.volume > 0) {
      if (!speakingSince) speakingSince = now;
    } else {
      // Muted (Ctrl+Alt+A), paused, or no level data: silence is expected, don't judge.
      if (st !== 'Speaking' || state.volume === 0 || now - lastMeterTick > 3000) { speakingSince = 0; return; }
      if (!speakingSince) speakingSince = now;
    }
    // Cloud voices can take several seconds before the FIRST sound of a message (test:
    // Dmitry Online started after ~6 s). Until the first sound: wait FIRST_SOUND_MS;
    // once sound has started: a gap longer than SILENT_MS means a hang.
    const sig = edge ? lastEdgeSignal : (lastSignal.get(engine.pid) || 0);
    const started = sig >= speakingSince;
    // Edge starts speaking within a second or two, so it gets a shorter first-sound limit.
    const limit = started ? SILENT_MS : (edge ? EDGE_FIRST_SOUND_MS : FIRST_SOUND_MS);
    const heard = Math.max(speakingSince, sig, graceUntil - limit);
    if (now - heard < limit) return;

    // Stuck: speaking with no sound.
    speakingSince = 0;
    const recent = autoRestarts.filter((t) => now - t < 5 * 60 * 1000);
    recent.push(now);
    autoRestarts.splice(0, autoRestarts.length, ...recent);
    const useFallback = recent.length >= 2 && state.voice !== FALLBACK_VOICE;
    const giveUp = recent.length > MAX_RESTARTS;
    const replay = giveUp ? [] : inflight.splice(0);
    if (giveUp) inflight.length = 0;
    wdLog(`engine speaking but silent ${Math.round((now - heard) / 1000)}s -> restart, ` +
      (giveUp ? `gave up after ${MAX_RESTARTS} restarts in 5 min, nothing replayed` :
        `replay ${replay.length} msg${useFallback ? ', fallback voice ' + FALLBACK_VOICE : ''}`));
    if (edge) {
      // Browser engine: restart the hidden Edge window, replay once its page polls again.
      // A silent Dmitry: switch to Svetlana right away (for EDGE_FALLBACK_MS).
      if (EDGE_VOICES[state.voice] !== 'svetlana' && !giveUp) {
        edgeFallbackUntil = Date.now() + EDGE_FALLBACK_MS;
        wdLog(`fallback to Svetlana for ${EDGE_FALLBACK_MS / 60000} min`);
      }
      edgeJobs.length = 0;
      await launchEdgeVoice('watchdog: speaking but silent');
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (edgeAlive() && edgeStatus.at > t0) {
          clearInterval(iv);
          graceUntil = Date.now() + COLD_START_MS;
          for (const m of replay) { inflight.push(m); countUsage(m.payload.length); edgeSpeak(m.payload, m.queue); }
        } else if (Date.now() - t0 > 30000) { clearInterval(iv); wdLog('edge window did not come back'); }
      }, 500);
      return;
    }
    // The exit handler respawns the engine and applies volume/rate/voice; the replay
    // starts only after that (no race between "VOICE <saved>" and the fallback voice).
    voiceOverride = useFallback ? FALLBACK_VOICE : null;
    if (useFallback) fallbackActive = true;
    onEngineRestored = async () => {
      voiceOverride = null;
      graceUntil = Date.now() + COLD_START_MS;           // a freshly started cloud voice needs a moment
      for (const m of replay) {
        inflight.push(m);
        countUsage(m.payload.length);
        await sendCmd(`${m.queue ? 'SPEAKQ' : 'SPEAK'} ${Buffer.from(m.payload, 'utf8').toString('base64')}`);
      }
    };
    restartEngine('watchdog: speaking but silent');
  } finally {
    wdBusy = false;
  }
}

function listVoicesPS() {
  return new Promise((resolve) => {
    const out = [];
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
       "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object {$_.Enabled} | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture + '|' + $_.VoiceInfo.Gender }"
      ],
      { windowsHide: true }
    );
    proc.stdout.on('data', (d) => out.push(d.toString('utf8')));
    proc.on('exit', () => {
      const lines = out.join('').split(/\r?\n/).filter(Boolean);
      const voices = lines.map((ln) => {
        const [name, culture, gender] = ln.split('|');
        return { name, culture, gender };
      });
      // The Edge online voices exist even without NaturalVoiceSAPIAdapter: they are
      // spoken by the Edge browser engine (see "Edge browser engine").
      if (EDGE_EXE) for (const n of Object.keys(EDGE_VOICES)) {
        if (!voices.some((v) => v.name === n)) voices.push({ name: n, culture: 'ru-RU', gender: n.includes('Dmitry') ? 'Male' : 'Female' });
      }
      resolve(voices);
    });
    proc.on('error', () => resolve(EDGE_EXE ? Object.keys(EDGE_VOICES).map((n) => ({ name: n, culture: 'ru-RU', gender: '' })) : []));
  });
}

// ---------- voice cycling (Russian only) ----------
let voiceList = []; // populated on startup, filtered to ru-RU
async function loadVoices() {
  try {
    const all = await listVoicesPS();
    // Keep only Russian (culture ru-RU OR name contains Irina/Dmitry/Svetlana/Pavel)
    voiceList = all
      .filter(v => /ru-RU/i.test(v.culture) || /Irina|Dmitry|Svetlana|Pavel|Anna|Russian/i.test(v.name))
      .map(v => v.name);
  } catch { voiceList = []; }
}
// loadVoices() is invoked from the httpServer 'listening' handler.

async function cycleVoice(direction = +1) {
  if (voiceList.length === 0) await loadVoices();
  if (voiceList.length === 0) return state.voice;
  const idx = voiceList.indexOf(state.voice);
  const nextIdx = ((idx === -1 ? 0 : idx) + direction + voiceList.length) % voiceList.length;
  state.voice = voiceList[nextIdx];
  saveState();
  await sendCmd(`VOICE ${state.voice}`);
  return state.voice;
}

async function adjustRate(delta) {
  state.rate = Math.max(-10, Math.min(10, state.rate + delta));
  saveState();
  await sendCmd(`RATE ${state.rate}`);
  return state.rate;
}

// ---------- HTTP control server for AutoHotkey ----------
const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  // POST /speak with body = text to speak
  if (req.method === 'POST' && req.url.startsWith('/speak')) {
    const sp = new URL(req.url, 'http://127.0.0.1').searchParams;
    const queue = sp.get('queue') === '1';
    const fromWatch = sp.get('src') === 'watch';
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const text = body.trim();
      if (!text) { res.statusCode = 400; res.end('empty'); return; }
      if (fromWatch) speakAsync(text, queue); else speakFromModel(text, queue);
      res.end(`Speaking ${text.length} chars${queue ? ' (queued)' : ''}`);
    });
    return;
  }
  // POST /suppress with body = text of a speak call seen in a LOCAL chat log.
  if (req.method === 'POST' && req.url.startsWith('/suppress')) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { res.end(registerSuppress(body)); });
    return;
  }
  // Edge voice page and its job feed (see "Edge browser engine" above).
  if (req.method === 'GET' && req.url.startsWith('/edge-voice')) {
    try { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(readFileSync(EDGE_PAGE)); }
    catch (e) { res.statusCode = 500; res.end('edge-voice.html missing'); }
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/edge/next')) {
    const q = new URL(req.url, 'http://127.0.0.1').searchParams;
    const gap = edgeStatus.at ? Date.now() - edgeStatus.at : 0;
    if (gap > 6000) wdLog(`edge poll gap ${Math.round(gap / 1000)}s (speaking=${edgeStatus.speaking}, pending=${edgeStatus.pending})`);
    Object.assign(edgeStatus, { at: Date.now(), speaking: q.get('speaking') === '1',
      pending: Number(q.get('pending') || 0), paused: q.get('paused') === '1', voices: q.get('voices') === '1' });
    res.setHeader('Content-Type', 'application/json');
    const send = () => { if (res.writableEnded) return; res.end(JSON.stringify({ jobs: edgeJobs.splice(0) })); };
    if (edgeJobs.length) return send();
    const t = setTimeout(send, 800);
    edgeWaiters.push(() => { clearTimeout(t); send(); });
    return;
  }
  // Parse pathname + query (req.url is path+query).
  const reqUrl = new URL(req.url, 'http://127.0.0.1');
  const pathname = reqUrl.pathname;
  const qp = reqUrl.searchParams;

  let result = '';
  switch (pathname) {
    // Playback control must answer FAST or self-heal: these are driven by
    // hotkeys, and a hotkey that hangs is indistinguishable from a broken one.
    case '/stop':         result = await stopSpeech(); break;
    case '/pause':        if (useEdge()) { edgePush({ type: 'pause' }); result = 'PAUSED'; } else result = await sendCmd('PAUSE', 1500); break;
    case '/resume':       if (useEdge()) { edgePush({ type: 'resume' }); result = 'RESUMED'; } else result = await sendCmd('RESUME', 1500); break;
    case '/toggle-pause': {
      if (useEdge()) { const p = edgeStatus.paused; edgePush({ type: p ? 'resume' : 'pause' }); result = p ? 'RESUMED' : 'PAUSED'; break; }
      result = await sendCmd('TOGGLE', 1500);
      if (result === 'TIMEOUT' || result === 'ENGINE_NOT_READY') {
        restartEngine('toggle-pause did not respond');
        result = 'STOPPED (engine restarted)';
      }
      break;
    }
    // Diagnostics must never hang either — a health check that blocks forever
    // is worse than one that honestly reports TIMEOUT.
    case '/state':        result = useEdge() ? edgeState() : await sendCmd('STATE', 1500); break;
    // Test hook: /edge-debug?silentDmitry=1 makes Dmitry speak at volume 0 (watchdog test).
    case '/edge-debug':   edgePush({ type: 'debug', silentDmitry: qp.get('silentDmitry') === '1' }); result = 'OK'; break;
    case '/edge-state':   result = JSON.stringify({ useEdge: useEdge(), alive: edgeAlive(), ...edgeStatus, lastSignalAgoMs: Date.now() - lastEdgeSignal }); break;
    case '/usage':        result = JSON.stringify({ ...usage, warnAt: USAGE_WARN, limit: USAGE_LIMIT }); break;
    case '/ping':         result = await sendCmd('PING', 1500); break;
    case '/rate-up': {
      const r = await adjustRate(+1);
      speakAsync(`Скорость ${r}`);
      result = String(r);
      break;
    }
    case '/rate-down': {
      const r = await adjustRate(-1);
      speakAsync(`Скорость ${r}`);
      result = String(r);
      break;
    }
    case '/voice-cycle':
    case '/voice-next': {
      const v = await cycleVoice(+1);
      const short = v.replace(/^Microsoft\s+/, '').replace(/\s+(Online|Desktop).*$/, '');
      speakAsync(`Голос ${short}`);
      result = v;
      break;
    }
    case '/voice-prev': {
      const v = await cycleVoice(-1);
      const short = v.replace(/^Microsoft\s+/, '').replace(/\s+(Online|Desktop).*$/, '');
      speakAsync(`Голос ${short}`);
      result = v;
      break;
    }
    case '/voice-set': {
      // /voice-set?name=Dmitry  (substring or exact match)
      const requested = (qp.get('name') || '').trim();
      if (!requested) { res.statusCode = 400; res.end('name required'); return; }
      try {
        const voices = await listVoicesPS();
        const match =
          voices.find(v => v.name.toLowerCase() === requested.toLowerCase()) ||
          voices.find(v => v.name.toLowerCase().includes(requested.toLowerCase()));
        if (!match) { res.statusCode = 404; res.end(`voice not found: ${requested}`); return; }
        state.voice = match.name;
        saveState();
        await sendCmd(`VOICE ${match.name}`);
        result = match.name;
      } catch (e) { res.statusCode = 500; res.end(`err: ${e.message}`); return; }
      break;
    }
    case '/rate-set': {
      // /rate-set?val=3
      const r = parseInt(qp.get('val'), 10);
      if (Number.isNaN(r)) { res.statusCode = 400; res.end('val required'); return; }
      state.rate = Math.max(-10, Math.min(10, r));
      saveState();
      await sendCmd(`RATE ${state.rate}`);
      result = String(state.rate);
      break;
    }
    case '/mute-toggle': {
      // Ctrl+Alt+A. Muting remembers the current volume; un-muting restores it.
      if (state.volume > 0) {
        state.lastVolume = state.volume;
        state.volume = 0;
        result = 'OFF';
      } else {
        state.volume = state.lastVolume > 0 ? state.lastVolume : 100;
        result = `ON ${state.volume}`;
      }
      saveState();
      await sendCmd(`VOLUME ${state.volume}`);
      break;
    }
    case '/volume-up':
    case '/volume-down': {
      // Ctrl+Alt+= / Ctrl+Alt+-  (also numpad +/-). Step 10, clamped to 0..100.
      const step = pathname === '/volume-up' ? 10 : -10;
      const before = state.volume;
      state.volume = Math.max(0, Math.min(100, Math.round((before + step) / 10) * 10));
      if (state.volume === 0 && before > 0) state.lastVolume = before; // stepped down to silence
      if (state.volume > 0) state.lastVolume = state.volume;
      saveState();
      await sendCmd(`VOLUME ${state.volume}`);
      result = state.volume === 0 ? 'OFF' : String(state.volume);
      break;
    }
    case '/volume-state': {
      // Diagnostics: saved volume vs. what the engine is actually using.
      const eng = await sendCmd('GETVOL', 1500);
      result = JSON.stringify({ saved: state.volume, lastVolume: state.lastVolume, engine: eng });
      break;
    }
    case '/volume-set': {
      // /volume-set?val=80
      const v = parseInt(qp.get('val'), 10);
      if (Number.isNaN(v)) { res.statusCode = 400; res.end('val required'); return; }
      state.volume = Math.max(0, Math.min(100, v));
      saveState();
      await sendCmd(`VOLUME ${state.volume}`);
      result = String(state.volume);
      break;
    }
    default:              res.statusCode = 404; res.end('not found'); return;
  }
  res.end(result);
});
httpServer.on('error', (err) => {
  // EADDRINUSE: another instance owns the port. This process runs in MCP-only mode and
  // forwards engine commands to the owner via HTTP (see isHttpOwner / forwardHttp).
  if (err.code !== 'EADDRINUSE') throw err;
});
httpServer.on('listening', () => {
  isHttpOwner = true;
  startEngine();
  applyState();
  loadVoices();
  startMeter();
  setInterval(watchdogTick, 1000);
});
httpServer.listen(HTTP_PORT, '127.0.0.1');

// ---------- MCP server ----------
const server = new Server(
  { name: 'claude-tts', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'speak',
    description:
      'Speak text aloud. Call as the FIRST action of a reply so the voice leads the on-screen text (NOT at the end). Pass the full reply text with markdown/code/file-paths stripped — it must match what you write to the user. Speech never interrupts: every call is queued after whatever is playing (other chats included). A normal call starts a NEW message — if something is still playing, the engine announces it with a 2 s pause and "Следующее сообщение". Set queue=true only to CONTINUE the same reply without that announcement. Long replies are spoken async.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak.' },
        queue: { type: 'boolean', description: 'true = continuation of the same reply (no "next message" announcement). Default false = new message. Neither interrupts.' },
      },
      required: ['text'],
    },
  },
  { name: 'stop',         description: 'Stop any currently playing speech immediately.', inputSchema: { type: 'object', properties: {} } },
  { name: 'pause',        description: 'Pause speech mid-utterance. Resume with resume or toggle_pause.', inputSchema: { type: 'object', properties: {} } },
  { name: 'resume',       description: 'Resume previously paused speech from the exact point.',           inputSchema: { type: 'object', properties: {} } },
  { name: 'toggle_pause', description: 'Toggle pause/resume of current speech.',                          inputSchema: { type: 'object', properties: {} } },
  {
    name: 'set_voice',
    description: 'Switch the active voice by full name or substring.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'set_rate',
    description: 'Set speech speed. SAPI scale: -10 (slowest) .. 0 (normal) .. 10 (fastest).',
    inputSchema: { type: 'object', properties: { rate: { type: 'integer', minimum: -10, maximum: 10 } }, required: ['rate'] },
  },
  {
    name: 'set_volume',
    description: 'Set volume 0..100.',
    inputSchema: { type: 'object', properties: { volume: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['volume'] },
  },
  { name: 'list_voices', description: 'List available SAPI voices on this system.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_state',   description: 'Return current voice, rate, volume, engine state.', inputSchema: { type: 'object', properties: {} } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case 'speak': {
        const text = String(args.text || '').trim();
        const queue = args.queue === true;
        if (!text) return { content: [{ type: 'text', text: 'empty text, skipped' }] };
        if (isHttpOwner) {
          speakFromModel(text, queue); // fire and forget; held, may be suppressed
        } else {
          try { await forwardHttp('POST', `/speak${queue ? '?queue=1' : ''}`, text); } catch (e) { return { content: [{ type: 'text', text: `forward error: ${e.message}` }], isError: true }; }
        }
        return { content: [{ type: 'text', text: `Speaking (${text.length} chars)${queue ? ' [queued]' : ''}${isHttpOwner ? ` with ${state.voice} at rate ${state.rate}` : ' (forwarded to owner)'}` }] };
      }
      case 'stop':         { const r = isHttpOwner ? await stopSpeech()      : await forwardHttp('GET', '/stop');         return { content: [{ type: 'text', text: r || 'stopped' }] }; }
      // Always via the HTTP handlers (also in the owner): they know about the Edge engine.
      case 'pause':        { const r = await forwardHttp('GET', '/pause');        return { content: [{ type: 'text', text: r || 'paused' }] }; }
      case 'resume':       { const r = await forwardHttp('GET', '/resume');       return { content: [{ type: 'text', text: r || 'resumed' }] }; }
      case 'toggle_pause': { const r = await forwardHttp('GET', '/toggle-pause'); return { content: [{ type: 'text', text: r }] }; }
      case 'set_voice': {
        const requested = String(args.name || '').trim();
        if (!requested) throw new Error('name required');
        if (!isHttpOwner) {
          try {
            const r = await forwardHttp('GET', `/voice-set?name=${encodeURIComponent(requested)}`);
            return { content: [{ type: 'text', text: `Voice -> ${r} (forwarded)` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: `forward error: ${e.message}` }], isError: true };
          }
        }
        const voices = await listVoicesPS();
        const match =
          voices.find((v) => v.name.toLowerCase() === requested.toLowerCase()) ||
          voices.find((v) => v.name.toLowerCase().includes(requested.toLowerCase()));
        if (!match) {
          return { content: [{ type: 'text', text: `Voice not found: "${requested}". Available: ${voices.map((v) => v.name).join(', ')}` }], isError: true };
        }
        state.voice = match.name;
        saveState();
        await sendCmd(`VOICE ${match.name}`);
        return { content: [{ type: 'text', text: `Voice -> ${match.name}` }] };
      }
      case 'set_rate': {
        const r = Math.max(-10, Math.min(10, parseInt(args.rate, 10)));
        if (!isHttpOwner) {
          try {
            const res = await forwardHttp('GET', `/rate-set?val=${r}`);
            return { content: [{ type: 'text', text: `Rate -> ${res} (forwarded)` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: `forward error: ${e.message}` }], isError: true };
          }
        }
        state.rate = r;
        saveState();
        await sendCmd(`RATE ${r}`);
        return { content: [{ type: 'text', text: `Rate -> ${r}` }] };
      }
      case 'set_volume': {
        const v = Math.max(0, Math.min(100, parseInt(args.volume, 10)));
        if (!isHttpOwner) {
          try {
            const res = await forwardHttp('GET', `/volume-set?val=${v}`);
            return { content: [{ type: 'text', text: `Volume -> ${res} (forwarded)` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: `forward error: ${e.message}` }], isError: true };
          }
        }
        state.volume = v;
        saveState();
        await sendCmd(`VOLUME ${v}`);
        return { content: [{ type: 'text', text: `Volume -> ${v}` }] };
      }
      case 'list_voices': {
        const voices = await listVoicesPS();
        const txt = voices.map((v) => `${v.name} [${v.culture}, ${v.gender}]`).join('\n');
        return { content: [{ type: 'text', text: txt || 'no voices' }] };
      }
      case 'get_state': {
        if (isHttpOwner) {
          const engineState = await sendCmd('STATE');
          return { content: [{ type: 'text', text: JSON.stringify({ ...state, engineState, httpPort: HTTP_PORT, role: 'owner' }, null, 2) }] };
        }
        // Forward to owner to get authoritative state (voice/rate may differ from local stale state).
        try {
          const engineState = await forwardHttp('GET', '/state');
          return { content: [{ type: 'text', text: JSON.stringify({ engineState, httpPort: HTTP_PORT, role: 'forwarder', localState: state }, null, 2) }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `forward error: ${e.message}` }], isError: true };
        }
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
