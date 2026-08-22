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
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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

// ---------- long-lived PowerShell engine ----------
const enginePath = join(PSDIR, 'tts-engine.ps1');
let engine = null;
let engineReady = false;
const pendingReplies = []; // queue of resolvers waiting for engine output

function startEngine() {
  engine = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', enginePath],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );

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
    // auto-restart after 1s
    setTimeout(() => startEngine(), 1000);
  });
}

function sendCmd(cmd) {
  return new Promise((resolve) => {
    if (!engine || !engineReady) {
      resolve('ENGINE_NOT_READY');
      return;
    }
    pendingReplies.push(resolve);
    try { engine.stdin.write(cmd + '\n'); }
    catch (e) { resolve('WRITE_ERR'); }
  });
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
function sanitizeForSpeech(input) {
  let t = String(input);
  t = t.replace(/```[\s\S]*?```/g, ' ');                       // code blocks
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
  t = t.replace(/[A-Za-z]:\\[^\s)"']+/g, ' ');                  // windows paths
  t = t.replace(/`([^`]+)`/g, '$1');                            // inline code marks
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function speakAsync(text, queue = false) {
  let payload = sanitizeForSpeech(text);
  if (!payload) return Promise.resolve('EMPTY');
  if (state.removePunctuationPauses) payload = payload.replace(/\s+/g, ' ');
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  return sendCmd(`${queue ? 'SPEAKQ' : 'SPEAK'} ${b64}`);
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
      resolve(voices);
    });
    proc.on('error', () => resolve([]));
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
    const queue = new URL(req.url, 'http://127.0.0.1').searchParams.get('queue') === '1';
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const text = body.trim();
      if (!text) { res.statusCode = 400; res.end('empty'); return; }
      speakAsync(text, queue);
      res.end(`Speaking ${text.length} chars${queue ? ' (queued)' : ''}`);
    });
    return;
  }
  // Parse pathname + query (req.url is path+query).
  const reqUrl = new URL(req.url, 'http://127.0.0.1');
  const pathname = reqUrl.pathname;
  const qp = reqUrl.searchParams;

  let result = '';
  switch (pathname) {
    case '/stop':         result = await sendCmd('STOP'); break;
    case '/pause':        result = await sendCmd('PAUSE'); break;
    case '/resume':       result = await sendCmd('RESUME'); break;
    case '/toggle-pause': result = await sendCmd('TOGGLE'); break;
    case '/state':        result = await sendCmd('STATE'); break;
    case '/ping':         result = await sendCmd('PING'); break;
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
      'Speak text aloud. Call as the FIRST action of a reply so the voice leads the on-screen text (NOT at the end). Pass the full reply text with markdown/code/file-paths stripped — it must match what you write to the user. Set queue=true to APPEND after the current speech instead of interrupting it (use for narrating intermediate steps within one reply); omit/false interrupts previous speech (normal single reply). Long replies are spoken async.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak.' },
        queue: { type: 'boolean', description: 'If true, append after current speech without interrupting. Default false.' },
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
          speakAsync(text, queue); // fire and forget
        } else {
          try { await forwardHttp('POST', `/speak${queue ? '?queue=1' : ''}`, text); } catch (e) { return { content: [{ type: 'text', text: `forward error: ${e.message}` }], isError: true }; }
        }
        return { content: [{ type: 'text', text: `Speaking (${text.length} chars)${queue ? ' [queued]' : ''}${isHttpOwner ? ` with ${state.voice} at rate ${state.rate}` : ' (forwarded to owner)'}` }] };
      }
      case 'stop':         { const r = isHttpOwner ? await sendCmd('STOP')   : await forwardHttp('GET', '/stop');         return { content: [{ type: 'text', text: r || 'stopped' }] }; }
      case 'pause':        { const r = isHttpOwner ? await sendCmd('PAUSE')  : await forwardHttp('GET', '/pause');        return { content: [{ type: 'text', text: r || 'paused' }] }; }
      case 'resume':       { const r = isHttpOwner ? await sendCmd('RESUME') : await forwardHttp('GET', '/resume');       return { content: [{ type: 'text', text: r || 'resumed' }] }; }
      case 'toggle_pause': { const r = isHttpOwner ? await sendCmd('TOGGLE') : await forwardHttp('GET', '/toggle-pause'); return { content: [{ type: 'text', text: r }] }; }
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
