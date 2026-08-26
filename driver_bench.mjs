// driver_bench.mjs — drive headless Chromium (SwiftShader WebGL) via CDP,
// run the GPU bench pages, print their #out results + any page errors.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const CHROME = "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const ROOT = "/root/src/sh2runtime";
const PORT = 8899;
const CDP = 9222;
const BASE = `http://127.0.0.1:${PORT}/www/`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const serve = spawn("python3", ["www/serve.py", String(PORT)], { cwd: ROOT, stdio: "ignore" });
mkdirSync("/tmp/chrome-bench-profile", { recursive: true });
const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-sandbox",
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader-webgl",
  `--remote-debugging-port=${CDP}`, "--user-data-dir=/tmp/chrome-bench-profile",
  "about:blank",
], { stdio: "ignore" });

let list = null;
for (let i = 0; i < 40; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); break; }
  catch { await sleep(250); }
}
if (!list) { console.error("no CDP endpoint"); process.exit(1); }
const page = list.find((t) => t.type === "page") || list[0];

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const i = ++id;
          pending.set(i, { res, rej });
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      },
      events,
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error("ws error"));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
      else if (m.method === "Runtime.exceptionThrown") events.push("EXC: " + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
      else if (m.method === "Runtime.consoleAPICalled") events.push("LOG: " + m.params.args.map((a) => a.value ?? a.description).join(" "));
    };
  });
}

const c = await connect(page.webSocketDebuggerUrl);
await c.send("Runtime.enable");
await c.send("Page.enable");
await c.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__errs=[]; window.addEventListener('error', e => window.__errs.push(String(e.message)));`,
});

async function evalJS(expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
}

// ── 0. WebGL probe ───────────────────────────────────────────────
await c.send("Page.navigate", { url: "about:blank" });
await sleep(600);
const gl = await evalJS(`(() => { const cv = document.createElement('canvas');
  const gl = cv.getContext('webgl', { antialias: false });
  if (!gl) return 'NO-WEBGL';
  return JSON.stringify({ maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), renderer: String(gl.getParameter(gl.RENDERER)) }); })()`);
console.log("WebGL probe:", gl);

async function runPage(name, url, marker, extra = "") {
  console.log(`\n========== ${name} ==========`);
  await c.send("Page.navigate", { url });
  await sleep(1500);
  let t = "";
  for (let i = 0; i < 600; i++) {
    t = (await evalJS("document.getElementById('out') ? document.getElementById('out').textContent : ''")) || "";
    if (t.includes(marker)) break;
    await sleep(300);
  }
  console.log(t || "(no output)");
  if (extra) await evalJS(extra);
  return t;
}

// ── 1. the fuzzy bench (template default: nl=2000, hl=5000) ─────
await runPage("www/fuzzy-bench.html (template, nl=2000 hl=5000)", "sentinel total", "sentinel total");

// a small-chunk fuzzy run: forces a many-pass template (compiles stay 1)
await evalJS(`document.getElementById('cs').value='64'; document.getElementById('run').click();`);
await sleep(800);
let t = "";
for (let i = 0; i < 600; i++) {
  t = (await evalJS("document.getElementById('out').textContent")) || "";
  if (t.includes("sentinel total")) break;
  await sleep(300);
}
console.log("\n========== fuzzy-bench (C=64 → many passes, template) ==========");
console.log(t || "(no output)");

// ── 2. the catalog page: collatz → ca1d → hash ──────────────────
await runPage("gpu-catalog-bench.html (collatz)", "draw+readback");
await evalJS(`document.getElementById('alg').value='ca1d'; document.getElementById('run').click();`);
await sleep(400);
t = "";
for (let i = 0; i < 600; i++) {
  t = (await evalJS("document.getElementById('out').textContent")) || "";
  if (t.includes("draw+readback") && t.includes("rule")) break;
  await sleep(300);
}
console.log("\n========== gpu-catalog-bench.html (ca1d) ==========");
console.log(t || "(no output)");
await evalJS(`document.getElementById('alg').value='hash'; document.getElementById('run').click();`);
await sleep(400);
t = "";
for (let i = 0; i < 600; i++) {
  t = (await evalJS("document.getElementById('out').textContent")) || "";
  if (t.includes("draw+readback") && t.includes("hashes")) break;
  await sleep(300);
}
console.log("\n========== gpu-catalog-bench.html (hash) ==========");
console.log(t || "(no output)");

const errs = await evalJS("JSON.stringify(window.__errs || [])");
if (errs !== "[]" && errs) console.log("\nPAGE ERRORS:", errs);
c.close();
serve.kill();
chrome.kill();
process.exit(0);
