#!/usr/bin/env node
// TTS auto-voice watcher (Cowork chats) — turn-based, no-double.
// Watches every Cowork session's audit.jsonl. At the END of each assistant turn
// (type=result, or the next real user message), it decides PER TURN:
//   - if the model called mcp__claude-tts__speak anywhere in the turn -> stay silent
//     (the model is voicing it; avoids double);
//   - otherwise -> voice only what the user reads in full: the final answer
//     (text after the last tool call) and send_user_message messages.
//     Narration between tool calls, API errors and English text are skipped.
// Pure file reader: no model, no API tokens. Fail-safe: errors are swallowed.

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOTS = process.argv.slice(2);
if (ROOTS.length === 0) {
  ROOTS.push(path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
    'Claude', 'local-agent-mode-sessions'));
}

const TTS_HOST = '127.0.0.1';
const TTS_PORT = 48329;
const POLL_MS = 1000;
const MAX_CHARS = 6000;

const LOG_FILE = 'C:\\ClaudeTTS\\tts-watch.log';
function log(m) { try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + m + '\n'); } catch {} }

// Single-instance guard: bind a local port; if another watcher already holds it,
// exit immediately. Prevents duplicate watchers (and thus double voicing).
try {
  const _lock = http.createServer(() => {});
  _lock.on('error', (e) => { if (e && e.code === 'EADDRINUSE') { log('duplicate instance -> exit'); process.exit(0); } });
  _lock.listen(48330, '127.0.0.1');
} catch { process.exit(0); }

const state = new Map();
let firstTick = true;

function walk(dir, out, depth) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) walk(full, out, depth + 1);
      else if (e.isFile() && e.name === 'audit.jsonl') out.push(full);
    } catch {}
  }
}
function listTranscripts() { const out = []; for (const r of ROOTS) walk(r, out, 0); return out; }

// Fenced blocks: read human prose (ready-to-send texts, quotes), skip code.
function isProseBlock(body) {
  const b = String(body);
  const letters = (b.match(/[A-Za-zА-Яа-яЁё]/g) || []).length;
  const cyr = (b.match(/[А-Яа-яЁё]/g) || []).length;
  const codeChars = (b.match(/[{}[\];=<>$\\|]/g) || []).length;
  if (letters < 3 || cyr < letters * 0.5) return false;
  return codeChars <= Math.max(1, b.length * 0.01);
}

function stripMarkdown(t) {
  return String(t)
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (m, body) => (isProseBlock(body) ? '\n' + body.trim() + '\n' : ' '))
    // Service/UI noise that must never be read aloud: tool-usage summaries
    // ("Used Desktop Commander integration", "(3 actions) · 4 notes"),
    // bare domains and file paths.
    .replace(/^[ \t]*(?:used|using)\b[^\n]*$/gim, ' ')
    .replace(/\([^)]*\b(?:actions?|notes?|steps?)\b[^)]*\)/gi, ' ')
    .replace(/·[^\n]*\b(?:actions?|notes?)\b/gi, ' ')
    .replace(/\b(?:mcp__|tool_use|tool_result)\S*/g, ' ')
    .replace(/\b[a-z0-9-]+\.(?:com|ru|org|net|io|ai|dev|me|app)\b(?:\/\S*)?/gi, ' ')
    .replace(/\n[ \t]{0,3}#{0,6}[ \t]*(?:\*\*|__)?(?:источник[аиов]*|использованн\w*\s+источник\w*|sources?|references?)(?:\*\*|__)?[ \t]*:[\s\S]*$/i, '\n')
    .replace(/\n[ \t]{0,3}(?:#{1,6}[ \t]*|\*\*|__)(?:источник[аиов]*|sources?|references?)(?:\*\*|__)?[ \t]*\r?\n[\s\S]*$/i, '\n')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:\\[^\s)]+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/^\s*[-=*]{3,}\s*$/gm, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function postSpeak(text) {
  try {
    const body = Buffer.from(text.slice(0, MAX_CHARS), 'utf8');
    const req = http.request({
      host: TTS_HOST, port: TTS_PORT, path: '/speak', method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length },
      timeout: 4000,
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => { try { req.destroy(); } catch {} });
    req.write(body); req.end();
  } catch {}
}

function asBlocks(c) {
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  if (Array.isArray(c)) return c;
  return [];
}
function textOf(c) {
  return asBlocks(c).filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n');
}
function hasSpeak(c) {
  return asBlocks(c).some((b) => b && b.type === 'tool_use'
    && typeof b.name === 'string' && /speak/i.test(b.name));
}
function hasToolResult(c) {
  return asBlocks(c).some((b) => b && b.type === 'tool_result');
}

// Only what the user actually reads is voiced:
//  - the final answer = text written AFTER the last tool call of the turn;
//  - messages sent through send_user_message (shown verbatim).
// Narration between tool calls ("Checking X:", often in English) is shown to the
// user only as a summary, so it is skipped. API error lines and mostly-Latin
// (English) text are skipped too — the voice is Russian.
function isVoiceable(text) {
  const t = String(text);
  if (/^\s*(?:API Error|Failed to authenticate|Request not allowed)/i.test(t)) return false;
  const cyr = (t.match(/[А-Яа-яЁё]/g) || []).length;
  const lat = (t.match(/[A-Za-z]/g) || []).length;
  return cyr > 0 && cyr >= lat * 0.5;
}

// Per-chat quiet mode, driven by the user's own words in that chat:
// «без озвучки» / «не озвучивай» / «выключи озвучку» (or a short «тихо»/«молча»)
// silence auto-voicing for that chat until «включи озвучку».
function updateQuiet(st, text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return;
  if (/включи(те)?\s+озвучк/.test(t)) { st.quiet = false; return; }
  if (/без\s+озвучк|не\s+озвучивай|выключи(те)?\s+озвучк/.test(t)) { st.quiet = true; return; }
  if (t.trim().length <= 40 && /(^|[^а-яё])(тихо|молча)([^а-яё]|$)/.test(t)) st.quiet = true;
}

function flushTurn(file, st) {
  if (st.quiet) { for (const p of st.turnTexts) st.voiced.add(p.uuid); st.turnTexts = []; st.lastToolSeq = -1; return; }
  if (!st.sawSpeak) {
    for (const p of st.turnTexts) {
      if (st.voiced.has(p.uuid)) continue;
      st.voiced.add(p.uuid);
      if (!p.direct && p.seq < st.lastToolSeq) continue; // narration between tool calls
      if (!isVoiceable(p.text)) continue;
      const clean = stripMarkdown(p.text);
      if (clean) { postSpeak(clean); log('VOICE ' + path.basename(path.dirname(file)) + ' ' + clean.length + 'c'); }
    }
  } else {
    for (const p of st.turnTexts) st.voiced.add(p.uuid);
  }
  st.turnTexts = [];
  st.lastToolSeq = -1;
  if (st.voiced.size > 2000) st.voiced.clear();
}

function handleEvent(file, st, ev) {
  const type = ev.type;
  const msg = ev.message || {};
  const content = msg.content;
  const role = msg.role || type;

  if (type === 'user' || role === 'user') {
    if (!ev.tool_use_result && !hasToolResult(content)) {
      flushTurn(file, st);     // close previous turn with its own sawSpeak
      st.sawSpeak = false;     // new user turn begins
      updateQuiet(st, textOf(content));
    }
    return;
  }
  if (type === 'result') { flushTurn(file, st); st.sawSpeak = false; return; }
  if (type === 'assistant' || role === 'assistant') {
    if (hasSpeak(content)) st.sawSpeak = true;
    const base = ev.uuid || ('t' + Date.now() + Math.random());
    asBlocks(content).forEach((b, i) => {
      if (!b) return;
      const seq = (st.seq = (st.seq || 0) + 1);
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        st.turnTexts.push({ uuid: base + ':' + i, text: b.text, seq });
      } else if (b.type === 'tool_use') {
        const msgText = b.input && typeof b.input.message === 'string' ? b.input.message : '';
        if (/send_user_message/i.test(b.name || '') && msgText.trim()) {
          st.turnTexts.push({ uuid: base + ':' + i, text: msgText, seq, direct: true });
        } else {
          st.lastToolSeq = seq;
        }
      }
    });
  }
}

function processFile(file) {
  let sz;
  try { sz = fs.statSync(file).size; } catch { return; }
  let st = state.get(file);
  if (!st) {
    const baseEnd = firstTick;
    st = { offset: baseEnd ? sz : 0, partial: '', sawSpeak: baseEnd, turnTexts: [], voiced: new Set(), seq: 0, lastToolSeq: -1 };
    state.set(file, st);
    if (baseEnd) return;
  }
  if (sz < st.offset) { st.offset = 0; st.partial = ''; st.sawSpeak = false; st.turnTexts = []; }
  if (sz <= st.offset) return;

  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    const len = sz - st.offset;
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.offset);
    fs.closeSync(fd);
  } catch { return; }
  st.offset = sz;

  const data = st.partial + buf.toString('utf8');
  const lines = data.split('\n');
  st.partial = lines.pop();
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let ev; try { ev = JSON.parse(s); } catch { continue; }
    try { handleEvent(file, st, ev); } catch {}
  }
}

function tick() {
  let files = [];
  try { files = listTranscripts(); } catch {}
  for (const f of files) processFile(f);
  firstTick = false;
}

setInterval(tick, POLL_MS);
tick();
log('started v4 (final answers only); roots=' + ROOTS.join(' ; '));
console.log('tts-watch v4 started');
