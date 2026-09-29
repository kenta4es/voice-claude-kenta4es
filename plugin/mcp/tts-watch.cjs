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
  // "$" is NOT a code sign here: prices ("50 $") are common in human texts.
  const codeChars = (b.match(/[{}[\];=<>\\|]|\$[({A-Za-z_]/g) || []).length;
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
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ')          // markdown tables: not read aloud
    .replace(/[A-Za-z]:[\\/][^\n\])"]*/g, ' ')       // Windows paths, spaces included, to end of line
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

function postSpeak(text, queue) {
  try {
    const body = Buffer.from(text.slice(0, MAX_CHARS), 'utf8');
    const req = http.request({
      host: TTS_HOST, port: TTS_PORT, path: '/speak?src=watch' + (queue ? '&queue=1' : ''), method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length },
      timeout: 4000,
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => { try { req.destroy(); } catch {} });
    req.write(body); req.end();
  } catch {}
}

// Claude called speak in a LOCAL chat: ask the server to drop that speech — the
// final answer is read verbatim from the screen instead (one voice, no repeats).
// If the server says it was already played (we were too late), fall back to
// skipping what Claude spoke.
function postSuppress(text, onPlayed) {
  try {
    const body = Buffer.from(String(text), 'utf8');
    const req = http.request({
      host: TTS_HOST, port: TTS_PORT, path: '/suppress', method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length },
      timeout: 3000,
    }, (res) => {
      let r = ''; res.setEncoding('utf8');
      res.on('data', (d) => { r += d; });
      res.on('end', () => { if (r.trim() !== 'OK') onPlayed(); });
    });
    req.on('error', () => onPlayed());
    req.on('timeout', () => { try { req.destroy(); } catch {} });
    req.write(body); req.end();
  } catch { onPlayed(); }
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

// Per-chat quiet mode — ONLY by the /voice skill command (a toggle). The app
// records a skill call as <command-name>/voice</command-name> (or with a
// plugin prefix, e.g. /anthropic-skills:voice). Ordinary words ("тихо",
// "без озвучки") never switch anything. Global silence: Ctrl+Alt+A.
const VOICE_CMD_RE = /<command-name>\/(?:[\w.-]+:)?voice<\/command-name>/g;
function updateQuiet(st, text) {
  const n = (String(text || '').match(VOICE_CMD_RE) || []).length;
  if (n % 2 === 1) st.quiet = !st.quiet;
}
// On first sight of a chat, replay its history: an odd number of /voice
// toggles so far means the chat is muted. Read in chunks (logs can be huge).
// Only real user messages count (not tool output, not code that mentions the tag).
function countVoiceToggles(file, upto) {
  let count = 0, pos = 0, rest = '';
  const CH = 8 * 1024 * 1024;
  const check = (line) => {
    if (line.indexOf('command-name') === -1 || line.indexOf('"type":"user"') === -1) return;
    try {
      const ev = JSON.parse(line);
      const c = ev.message && ev.message.content;
      if (ev.tool_use_result || hasToolResult(c)) return;
      count += (textOf(c).match(VOICE_CMD_RE) || []).length;
    } catch {}
  };
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CH);
    while (pos < upto) {
      const n = fs.readSync(fd, buf, 0, Math.min(CH, upto - pos), pos);
      if (n <= 0) break;
      const lines = (rest + buf.toString('utf8', 0, n)).split('\n');
      rest = lines.pop();
      for (const line of lines) check(line);
      pos += n;
    }
    if (rest) check(rest);
    fs.closeSync(fd);
  } catch {}
  return count;
}

// ---- What was already spoken this turn (Claude's own speak calls) ----------
// Words of >=3 letters, lower-case, ё→е. Used to avoid reading twice what the
// model has already voiced itself.
function words(t) {
  return (String(t).toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]{3,}/g) || []);
}
// Compare by PAIRS of consecutive words, not single words: a new block that only
// shares vocabulary with what was said ("ChatGPT Plus", "месяц") must still be
// read; a paragraph Claude actually spoke shares its word pairs.
function pairs(t) {
  const w = words(t), out = [];
  for (let i = 0; i + 1 < w.length; i++) out.push(w[i] + ' ' + w[i + 1]);
  return out;
}
function coverage(text, spokenBag) {
  const p = pairs(text);
  if (!p.length) return words(text).length ? 0 : 1;
  const bag = new Map(spokenBag);
  let hit = 0;
  for (const x of p) { const n = bag.get(x) || 0; if (n > 0) { hit++; bag.set(x, n - 1); } }
  return hit / p.length;
}
function spokenBagOf(st) {
  const bag = new Map();
  for (const s of st.spoken || []) for (const x of pairs(s)) bag.set(x, (bag.get(x) || 0) + 1);
  return bag;
}
const COVERED = 0.5; // a paragraph whose word pairs were at least half spoken is not read again

// Claude often voices a SHORTENED retelling of its answer, not the exact text:
// word pairs then barely match and the watcher used to read the whole answer a
// second time. So ordinary paragraphs are compared by word STEMS (first 5
// letters of words of 4+ letters — survives Russian endings and rewording):
// half of the stems already spoken = the paragraph was voiced. Ready-to-send
// texts in a frame stay on the strict pair test: those must be read as written.
function stems(t) { return words(t).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)); }
function stemCoverage(text, spokenStems) {
  const s = stems(text);
  if (!s.length) return words(text).length ? 0 : 1;
  let hit = 0;
  for (const x of s) if (spokenStems.has(x)) hit++;
  return hit / s.length;
}
function spokenStemsOf(st) {
  const set = new Set();
  for (const s of st.spoken || []) for (const x of stems(s)) set.add(x);
  return set;
}
function proseBlocksOf(text) {
  const out = [];
  String(text).replace(/```[^\n]*\n?([\s\S]*?)```/g, (m, body) => { if (isProseBlock(body)) out.push(body); return m; });
  return out.join('\n');
}
// Was this paragraph already voiced by Claude itself?
function alreadySpoken(t, bag, stemSet, blocksText) {
  const fromBlock = blocksText && coverage(t, (() => {
    const m = new Map(); for (const x of pairs(blocksText)) m.set(x, (m.get(x) || 0) + 1); return m;
  })()) >= 0.8;
  if (fromBlock) return coverage(t, bag) >= COVERED;
  return stemCoverage(t, stemSet) >= COVERED;
}

// Final answer, read from the SCREEN after it is written.
// Everything written on screen so far in this turn and not yet voiced is read
// now: called when Claude starts a tool (the text before it is a progress line
// the user sees — «Проверяю журнал…») and at the end of the turn (the final
// answer). Only Russian text is voiced; English lines are skipped. The first
// piece of a turn starts a new message, the rest continue it (no «Следующее
// сообщение» between progress lines of the same answer).
function voicePending(file, st, kind) {
  if (st.quiet) { for (const p of st.turnTexts) st.voiced.add(p.uuid); return; }
  const bag = spokenBagOf(st);
  const stemSet = spokenStemsOf(st);
  const parts = [];
  for (const p of st.turnTexts) {
    if (st.voiced.has(p.uuid)) continue;
    st.voiced.add(p.uuid);
    if (p.direct) continue;                  // mid-task messages were voiced on arrival
    if (!isVoiceable(p.text)) continue;
    const blocksText = proseBlocksOf(p.text);
    for (const para of stripMarkdown(p.text).split(/\n\s*\n/)) {
      const t = para.trim();
      if (!t || !/[А-Яа-яЁё]/.test(t)) continue;
      if (alreadySpoken(t, bag, stemSet, blocksText)) continue;
      parts.push(t);
    }
  }
  const out = parts.join('\n\n').trim();
  if (out) {
    postSpeak(out, !!st.turnVoiced);
    st.turnVoiced = true;
    log('VOICE ' + path.basename(path.dirname(file)) + ' ' + kind + ' ' + out.length + 'c');
  }
}
function flushTurn(file, st) {
  voicePending(file, st, 'final');
  st.turnTexts = []; st.lastToolSeq = -1; st.spoken = []; st.turnVoiced = false;
  if (st.voiced.size > 2000) st.voiced.clear();
}

// Mid-task message to the user (send_user_message): voice it right away,
// unless Claude already spoke it.
function voiceDirectNow(file, st, item) {
  if (st.quiet || st.voiced.has(item.uuid)) return;
  st.voiced.add(item.uuid);
  if (!isVoiceable(item.text)) return;
  const t = stripMarkdown(item.text);
  if (!t || alreadySpoken(t, spokenBagOf(st), spokenStemsOf(st), proseBlocksOf(item.text))) return;
  postSpeak(t, !!st.turnVoiced); st.turnVoiced = true;
  log('VOICE ' + path.basename(path.dirname(file)) + ' message ' + t.length + 'c');
}

function handleEvent(file, st, ev) {
  const type = ev.type;
  const msg = ev.message || {};
  const content = msg.content;
  const role = msg.role || type;

  if (type === 'user' || role === 'user') {
    if (!ev.tool_use_result && !hasToolResult(content)) {
      flushTurn(file, st);     // close the previous turn
      updateQuiet(st, textOf(content));
    }
    return;
  }
  if (type === 'result') { flushTurn(file, st); return; }
  if (type === 'assistant' || role === 'assistant') {
    const base = ev.uuid || ('t' + Date.now() + Math.random());
    asBlocks(content).forEach((b, i) => {
      if (!b) return;
      const seq = (st.seq = (st.seq || 0) + 1);
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        st.turnTexts.push({ uuid: base + ':' + i, text: b.text, seq });
      } else if (b.type === 'tool_use') {
        const name = b.name || '';
        const inp = b.input || {};
        if (/claude-tts__speak$/i.test(name) || /(^|__)speak$/i.test(name)) {
          const said = String(inp.text || '');
          // Drop Claude's own speech; the screen text is read instead. If it
          // already played, remember it so it is not read a second time.
          postSuppress(said, () => { (st.spoken = st.spoken || []).push(said); });
          return;                                                      // not a "real" tool call
        }
        const msgText = typeof inp.message === 'string' ? inp.message : '';
        if (/send_user_message/i.test(name) && msgText.trim()) {
          const item = { uuid: base + ':' + i, text: msgText, seq, direct: true };
          st.turnTexts.push(item);
          voiceDirectNow(file, st, item);
        } else {
          st.lastToolSeq = seq;
          voicePending(file, st, 'step');   // progress line written before this tool
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
    st = { offset: baseEnd ? sz : 0, partial: '', sawSpeak: baseEnd, turnTexts: [], voiced: new Set(), seq: 0, lastToolSeq: -1, quiet: false };
    if (baseEnd) st.quiet = countVoiceToggles(file, sz) % 2 === 1;
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
