// Claude TTS — Speak Selection
// Отправляет выделенный текст в локальный сервер Claude TTS (тот же, что
// озвучивает Клода). Никакого собственного TTS — переиспользуем движок и
// голос Дмитрий через HTTP-управление на 127.0.0.1:48329.

const vscode = require('vscode');
const http = require('http');

function cfg() {
  const c = vscode.workspace.getConfiguration('claudeTts');
  return {
    host: c.get('host', '127.0.0.1'),
    port: c.get('port', 48329),
    strip: c.get('stripMarkdown', true),
    wholeDoc: c.get('speakWholeDocIfNoSelection', true),
  };
}

function request(method, path, body) {
  const { host, port } = cfg();
  return new Promise((resolve, reject) => {
    const opts = { host, port, path, method, timeout: 5000 };
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body != null) req.write(body);
    req.end();
  });
}

function stripMarkdown(t) {
  return t
    .replace(/```[\s\S]*?```/g, ' ')        // блоки кода
    .replace(/`([^`]+)`/g, '$1')             // инлайн-код
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // картинки
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // ссылки -> текст
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')        // заголовки
    .replace(/^\s{0,3}>\s?/gm, '')             // цитаты
    .replace(/^\s*[-*+]\s+/gm, '')             // маркеры списка
    .replace(/^\s*\d+\.\s+/gm, '')             // нумерованный список
    .replace(/(\*\*|__)(.*?)\1/g, '$2')        // жирный
    .replace(/(\*|_)(.*?)\1/g, '$2')            // курсив
    .replace(/~~(.*?)~~/g, '$1')                // зачёркнутый
    .replace(/\|/g, ' ')                         // таблицы
    .replace(/^\s*[-=*]{3,}\s*$/gm, ' ')         // горизонтальные линии
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function speak() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    vscode.window.showInformationMessage('Claude TTS: нет активного редактора');
    return;
  }
  const { strip, wholeDoc, port } = cfg();
  let text = ed.document.getText(ed.selection);
  let src = 'выделение';
  if (!text || !text.trim()) {
    if (wholeDoc) { text = ed.document.getText(); src = 'весь документ'; }
    else { vscode.window.showInformationMessage('Claude TTS: ничего не выделено'); return; }
  }
  if (strip) text = stripMarkdown(text);
  text = text.trim();
  if (!text) { vscode.window.showInformationMessage('Claude TTS: пустой текст'); return; }
  try {
    await request('POST', '/speak?queue=1', text);
    vscode.window.setStatusBarMessage(`🔊 Claude TTS: озвучка (${src}, ${text.length} симв.)`, 4000);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Claude TTS: сервер недоступен (${e.message}). Запущен ли Claude TTS на порту ${port}?`
    );
  }
}

async function ctrl(path, label) {
  const { port } = cfg();
  try {
    await request('GET', path);
    vscode.window.setStatusBarMessage(`🔊 Claude TTS: ${label}`, 2000);
  } catch (e) {
    vscode.window.showErrorMessage(`Claude TTS: ${e.message} (порт ${port})`);
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTts.speak', speak),
    vscode.commands.registerCommand('claudeTts.togglePause', () => ctrl('/toggle-pause', 'пауза / продолжить')),
    vscode.commands.registerCommand('claudeTts.stop', () => ctrl('/stop', 'стоп'))
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
