// ─── bench-browser-playwright.mjs — run the GPU bench pages in a real browser ──
// Drives the bench pages with Playwright (playwright-core + the cached
// Chromium binary, WebGL via SwiftShader) and collects the results.
//
//   node bench-browser-playwright.mjs            # runs both pages, prints + writes results.json
//   node bench-browser-playwright.mjs --page fuzzy|catalog
//   node bench-browser-playwright.mjs --out /tmp/bench.json
//   node bench-browser-playwright.mjs --headed   # visible window (real GPU, if any)
//
// What it measures (browser-only): the in-browser bash→GLSL compile and
// the real draw+readback timing, plus the PASS checks each page prints
// (chunked/template == CPU reference, 0 sentinels, strict-ES-1.00
// fallback engagement on compilers that reject dynamic loops).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const ROOT = new URL(".", import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH ||
  "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}/www/`;
const args = process.argv.slice(2);
const pageArg = (args.find((a) => a.startsWith("--page")) || "--page all").split("=")[1] ||
  (args.includes("--page") ? args[args.indexOf("--page") + 1] : "all");
const headed = args.includes("--headed");
const outFile = (args.find((a) => a.startsWith("--out")) || "").split("=")[1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serve = spawn("python3", ["www/serve.py", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await sleep(1200);

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: [
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-sandbox",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader-webgl",
  ],
});
const pageCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const p = await pageCtx.newPage();
p.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 200)); });
p.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
const results = { webgl: null, pages: {} };

async function waitOut(marker, timeoutMs = 90000) {
  try {
    await p.waitForFunction(
      (mk) => {
        const el = document.getElementById("out");
        return !!el && el.textContent.includes(mk);
      },
      marker,
      { timeout: timeoutMs }
    );
  } catch (e) {
    const cur = await p.evaluate(() => document.getElementById("out")?.textContent || "(none)").catch(() => "(page gone)");
    throw new Error(marker + " not seen; current out: " + cur.slice(0, 300) + " | " + e.message);
  }
  return p.evaluate(() => document.getElementById("out").textContent);
}

// the renderer probe (what the timing numbers belong to)
await p.goto(BASE + "_loopprobe.html").catch(() => {});
await sleep(600);
try {
  results.webgl = await p.evaluate(`(() => { const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl', { antialias: false });
    if (!gl) return 'NO-WEBGL';
    return String(gl.getParameter(gl.RENDERER)); })()`);
} catch { results.webgl = "(probe skipped)"; }
console.log("renderer:", results.webgl);

if (pageArg === "all" || pageArg === "fuzzy") {
  // a quick case (SwiftShader software rendering: the default nl=2000/hl=5000
  // strict-template run is ~5 min here — the full default is the documented
  // manual run; real GPUs do it in ms)
  console.log("========== www/fuzzy-bench.html?nl=100&hl=1000 (template + strict fallback) ==========");
  await p.goto(BASE + "fuzzy-bench.html?nl=100&hl=1000");
  const t = await waitOut("sentinel total", 240000);
  results.pages.fuzzyStrict = t;
  console.log(t);
  console.log("\n--- the same page at the DEFAULT size (nl=2000 hl=5000, strict fallback, slow on SwiftShader) ---");
  await p.goto(BASE + "fuzzy-bench.html?nl=2000&hl=5000");
  const t2 = await waitOut("sentinel total", 900000);
  results.pages.fuzzyDefault = t2;
  console.log(t2);
}

if (pageArg === "all" || pageArg === "catalog") {
  console.log("\n========== www/gpu-catalog-bench.html ==========");
  await p.goto(BASE + "gpu-catalog-bench.html");
  results.pages.collatz = await waitOut("draw+readback");
  console.log("\n--- collatz ---\n" + results.pages.collatz);
  await p.evaluate(`document.getElementById('alg').value='ca1d'; document.getElementById('run').click();`);
  results.pages.ca1d = await waitOut("rule");
  console.log("\n--- ca1d ---\n" + results.pages.ca1d);
  await p.evaluate(`document.getElementById('alg').value='hash'; document.getElementById('run').click();`);
  results.pages.hash = await waitOut("hashes");
  console.log("\n--- hash ---\n" + results.pages.hash);
}

await browser.close();
serve.kill();
if (outFile) { writeFileSync(outFile, JSON.stringify(results, null, 2)); console.log("\nwrote", outFile); }
