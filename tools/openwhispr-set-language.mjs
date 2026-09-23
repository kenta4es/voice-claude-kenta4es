// Sets OpenWhispr's dictation language (localStorage "preferredLanguage") through the
// Chrome DevTools Protocol. OpenWhispr 1.10 only asks for the language during onboarding
// and has no setting for it afterwards; without it Deepgram Nova-3 assumes English.
//
// Normally run by openwhispr-set-language.ps1, which restarts OpenWhispr with
// --remote-debugging-port, runs this script, then restarts it normally.
//
// Usage: node openwhispr-set-language.mjs [lang] [port]      e.g.  ru 9229
// Node 22+ has WebSocket built in; on Node 20.10-21 add --experimental-websocket.

const lang = process.argv[2] || "ru";
const port = process.argv[3] || "9229";

if (!/^(auto|[a-z]{2}(-[A-Z]{2})?)$/.test(lang)) {
  console.error(`Invalid language code: ${lang}`);
  process.exit(2);
}
if (typeof WebSocket === "undefined") {
  console.error("This Node has no WebSocket. Use Node 22+, or Node 20.10+ with --experimental-websocket.");
  process.exit(3);
}

const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((p) => p.type === "page");
const main = pages.find((p) => !p.url.includes("panel=true")) || pages[0];
if (!main) {
  console.error("No OpenWhispr page found on the debugging port.");
  process.exit(4);
}

const ws = new WebSocket(main.webSocketDebuggerUrl);
let id = 0;
const call = (method, params) =>
  new Promise((resolve) => {
    const my = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === my) {
        ws.removeEventListener("message", onMsg);
        resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: my, method, params }));
  });

await new Promise((r) => ws.addEventListener("open", r));
const expr = `(() => {
  const before = localStorage.getItem('preferredLanguage');
  localStorage.setItem('preferredLanguage', ${JSON.stringify(lang)});
  return JSON.stringify({ before, after: localStorage.getItem('preferredLanguage') });
})()`;
const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log("preferredLanguage:", r?.result?.value);
ws.close();
