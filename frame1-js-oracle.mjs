// frame1-js-oracle.mjs — capture the JS oracle's frame 1 (genuine oracle).
// Playwright + Chromium + SwiftShader, serve www/, auto-start the ORIGINAL
// www/bin/mimecroft.sh (no _fb) via ?demo=, SPACE past any menu, wait for
// `ready.` + settle, then gl.readPixels at the device canvas size + a PNG.
// Usage: node frame1-js-oracle.mjs [--port 8060] [--out /tmp/js-frame1]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const ROOT = "/mnt/wsl/projects/jcmd";
const CHROME = process.env.CHROME_PATH ||
  "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const args = process.argv.slice(2);
const PORT = Number(((args.find((a) => a.startsWith("--port=")) || "--port=8060").split("="))[1]);
const OUT = ((args.find((a) => a.startsWith("--out=")) || "--out=/tmp/js-frame1").split("="))[1];
const BASE = `http://127.0.0.1:${PORT}/www/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serve = spawn("python3", ["www/serve.py", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await sleep(1500);

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-sandbox",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader-webgl"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));

// auto-start the game WITHOUT the --demo patrol: plain MIMEcroft.sh sits at
// frame 1 (settings menu or idle game), not a 10s auto-play.
await p.goto(BASE + "index.html?demo=MIMEcroft.sh", { waitUntil: "load", timeout: 60000 });
await p.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await p.waitForSelector("#terminal", { timeout: 30000 });
console.log("page loaded, game booting...");

// wait for the terminal to print `ready.` (textures done, loop rendering)
const termText = () => p.evaluate(() => {
  const t = document.getElementById("terminal");
  return (t ? t.innerText : document.body.innerText) || "";
}).catch(() => "");
const termTail = async (n) => (await termText()).slice(-n);
// Poll FAST (500ms): xterm trims scrollback, so `ready.` scrolls out of
// innerText during a long run — catch it while visible, capture at once.
let ready = false;
for (let i = 0; i < 480; i++) {
  await sleep(500);
  const txt = await termText();
  // `ready.` may already have scrolled out of xterm's trimmed scrollback
  // (long texture-loading logs push it out) — the loop's own progress
  // past loading (mimes moving, MIME sanitised lines, GAME DONE) also
  // proves frame 1 rendered.
  if (txt.includes("ready.") || txt.includes("GAME DONE") || txt.includes("MIME sanitised") || txt.includes("shader link FAILED")) { ready = true; break; }
  if (i % 40 === 0 && i > 0) console.log(`  waiting for ready. (${i / 2}s) ...`);
}
if (!ready) {
  const txt = await termTail(500);
  console.log("FATAL: never saw `ready.`; tail:", JSON.stringify(txt));
  await browser.close(); serve.kill(); process.exit(2);
}
console.log("saw first ready., capturing frame 1 NOW (no settle — the game plays on)...");

// dismiss any menu with SPACE only if a menu is up (frame1 recipe: SPACE then ready+2s)
// The auto-started game may already be past the menu; SPACE on an idle game shoots —
// so check first: only press SPACE when the terminal still shows the settings menu.
const needSpace = await p.evaluate(() => {
  const el = document.getElementById("terminal");
  const t = (el ? el.innerText : document.body.innerText) || "";
  return /settings|DISPLAY|SOUND MODE/i.test(t.slice(-1500));
}).catch(() => false);
if (needSpace) {
  console.log("menu detected, pressing SPACE...");
  await p.evaluate(() => document.getElementById("hidden-input").focus());
  await p.keyboard.press("Space");
  // wait for ready. again after the menu dismiss
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const txt = await p.evaluate(() => ((document.getElementById("term") || document.body).innerText || "").slice(-2000)).catch(() => "");
    if (txt.includes("ready.")) break;
  }
  await sleep(3000);
} else {
  console.log("no menu detected, capturing idle frame 1 directly.");
}

const shot = await p.evaluate(() => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return { error: "no canvas" };
  const gl = canvas.getContext("webgl") || canvas.getContext("webgl2") || canvas.getContext("experimental-webgl");
  const W = canvas.width, H = canvas.height;
  const out = { width: W, height: H };
  // PNG snapshot (composited page) for eyeballing
  try { out.png = canvas.toDataURL("image/png"); } catch (e) { out.pngErr = String(e).slice(0, 100); }
  if (gl) {
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.px = Array.from(px);
    out.renderer = String(gl.getParameter(gl.RENDERER) || "?").slice(0, 80);
  } else {
    // 2d canvas fallback: read back via 2d context
    try {
      const c2 = document.createElement("canvas");
      c2.width = W; c2.height = H;
      const g2 = c2.getContext("2d");
      g2.drawImage(canvas, 0, 0);
      const im = g2.getImageData(0, 0, W, H).data;
      out.px = Array.from(im);
      out.via = "2d-drawImage";
    } catch (e) { out.pxErr = String(e).slice(0, 200); }
  }
  return out;
});

if (shot.error) { console.log("FATAL:", shot.error); await browser.close(); serve.kill(); process.exit(2); }
console.log(`canvas ${shot.width}x${shot.height} renderer=${shot.renderer || shot.via || "?"}`);
if (!shot.px) { console.log("FATAL: no pixels:", shot.pxErr || "?"); await browser.close(); serve.kill(); process.exit(2); }

// raw RGBA dump (bottom-up GL order) + PNG snapshot
const raw = Buffer.from(shot.px);
writeFileSync(OUT + `.${shot.width}x${shot.height}.rgba`, raw);
console.log("wrote", OUT + `.${shot.width}x${shot.height}.rgba`, raw.length, "bytes");
if (shot.png && shot.png.startsWith("data:image/png;base64,")) {
  writeFileSync(OUT + ".png", Buffer.from(shot.png.split(",")[1], "base64"));
  console.log("wrote", OUT + ".png");
}
// PPM (top-down RGB) for direct diffing
const W = shot.width, H = shot.height;
const ppm = Buffer.alloc(15 + W * H * 3);
ppm.write(`P6\n${W} ${H}\n255\n`);
for (let y = 0; y < H; y++) {
  const sy = H - 1 - y; // GL bottom-up -> top-down
  for (let x = 0; x < W; x++) {
    const s = (sy * W + x) * 4, d = 15 + (y * W + x) * 3;
    ppm[d] = raw[s]; ppm[d + 1] = raw[s + 1]; ppm[d + 2] = raw[s + 2];
  }
}
writeFileSync(OUT + `.${W}x${H}.ppm`, ppm);
console.log("wrote", OUT + `.${W}x${H}.ppm`);
await browser.close(); serve.kill();
console.log("done.");
