#!/usr/bin/env node
// TTS auto-voice watcher (Cowork chats) — turn-based, no-double.
// Watches every Cowork session's audit.jsonl. At the END of each assistant turn
// (type=result, or the next real user message), it decides PER TURN:
//   - if the model called mcp__claude-tts__speak anywhere in the turn -> stay silent
//     (the model is voicing it; avoids double);
//   - otherwise -> voice every visible text block of the turn (intermediate
//     preambles + final), in order, through the local TTS server.
// Pure file reader: no model, no API tokens. Fail-safe: errors are swallowed.

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOTS = process.argv.slice(2);
if (ROOTS.length === 0) {
  ROOTS.push('C:\\Users\\Alexander\\AppData\\Roaming\\Claude\\local-agent-mode-sessions');
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

function stripMarkdown(t) {
  return String(t)
    .replace(/```[\s\S]*?```/g, ' ')
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

function flushTurn(file, st) {
  if (!st.sawSpeak) {
    for (const p of st.turnTexts) {
      if (st.voiced.has(p.uuid)) continue;
      st.voiced.add(p.uuid);
      const clean = stripMarkdown(p.text);
      if (clean) { postSpeak(clean); log('VOICE ' + path.basename(path.dirname(file)) + ' ' + clean.length + 'c'); }
    }
  } else {
    for (const p of st.turnTexts) st.voiced.add(p.uuid);
  }
  st.turnTexts = [];
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
    }
    return;
  }
  if (type === 'result') { flushTurn(file, st); st.sawSpeak = false; return; }
  if (type === 'assistant' || role === 'assistant') {
    if (hasSpeak(content)) st.sawSpeak = true;
    const t = textOf(content);
    if (t && t.trim()) st.turnTexts.push({ uuid: ev.uuid || ('t' + Date.now() + Math.random()), text: t });
  }
}

function processFile(file) {
  let sz;
  try { sz = fs.statSync(file).size; } catch { return; }
  let st = state.get(file);
  if (!st) {
    const baseEnd = firstTick;
    st = { offset: baseEnd ? sz : 0, partial: '', sawSpeak: baseEnd, turnTexts: [], voiced: new Set() };
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
log('started v3 (turn-based); roots=' + ROOTS.join(' ; '));
console.log('tts-watch v3 started');
