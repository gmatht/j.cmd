// ─── otranspiler-py-worker-smoke.mjs — python runs on the otranspiler page ──
//
// REGRESSION GUARD for the module-worker/importScripts bug:
//
//   https://gmatht.github.io/j.cmd/www/otranspiler.html#lang=py&target=js
//   [stderr] micropython in a worker needs a CLASSIC worker (importScripts
//            is not available in a module worker): Failed to execute
//            'importScripts' on 'WorkerGlobalScope': Module scripts don't
//            support importScripts().
//
// The page's stages run in MODULE workers (www/otranspile-job.js is spawned
// with `{ type: "module" }`). The micropython engine glue is a CLASSIC
// emscripten script, so it cannot be hosted there:
//   • importScripts() is illegal in module scope;
//   • a dynamic import() of the glue evals it with `var Module` in MODULE
//     scope, so self.Module stays undefined.
// Python runs are therefore bridged to the nested CLASSIC worker
// www/vendor/py-worker.js. This harness drives the real page (Playwright +
// the static server) and asserts, for #lang=py&target=js:
//
//   1. the ORIGINAL python pane runs and prints (orig exit 0, real stdout)
//   2. the TRANSPILED JS pane runs and prints the same value
//   3. no "importScripts"/module-worker error anywhere (console, panes,
//      pageerror)
//   4. the classic bridge is genuinely nested (py-worker.js is requested)
//
//   node bench/otranspiler-py-worker-smoke.mjs            # headless
//   node bench/otranspiler-py-worker-smoke.mjs --headed
//
// The page is large (transpiler wasm + micropython wasm) so the budget is
// generous; micropython's wasm is ~1.2 MB and the busybox frontend is
// fetched on demand.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import net from "node:net";
import pkg from "playwright-core";
const { chromium } = pkg;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Chromium is a CI dependency, not a repo one. When it is absent (a fresh
// runner, a checkout without `npx playwright install`) the honest behaviour
// is SKIP, not FAIL: a missing browser says nothing about the code under
// test, and a hard failure blocks every deploy for an unrelated reason.
// Set the path explicitly with CHROME_PATH, or install it with
//   npx playwright install chromium
//
// The Playwright cache dir encodes a BUILD NUMBER (chromium-1234), which
// changes when playwright-core is bumped — so glob it instead of pinning
// one build (a pinned number silently turned the gate into a no-op).
function playwrightChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.HOME ? `${process.env.HOME}/.cache/ms-playwright` : null,
    "/root/.cache/ms-playwright",
  ].filter(Boolean);
  for (const root of roots) {
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
    // prefer the full chromium build over the headless shell
    const dirs = entries.filter((e) => /^chromium-\d+$/.test(e)).sort().reverse();
    for (const d of dirs) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
        const p = `${root}/${d}/${rel}`;
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

const CANDIDATES = [
  process.env.CHROME_PATH,
  playwrightChromium(),
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => { try { return existsSync(p); } catch { return false; } });
if (!CHROME) {
  console.log("SKIP otranspiler python-in-worker smoke: no chromium found");
  console.log("     (looked in: " + CANDIDATES.join(", ") + ")");
  console.log("     install with: npx playwright install chromium   — or set CHROME_PATH");
  process.exit(0);
}

const freePort = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const PORT = Number(process.env.OTRANSPILER_PY_TEST_PORT || freePort);
const PAGE = `http://127.0.0.1:${PORT}/www/otranspiler.html`;
const headed = process.argv.includes("--headed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (cond, what, detail) => {
  if (cond) { console.log("  ok   " + what); return; }
  failures++;
  console.log("  FAIL " + what + (detail ? "\n       " + detail : ""));
};

let serve = spawn("python3", ["www/serve.py", String(PORT)], { cwd: ROOT, stdio: "ignore" });
const shutdown = () => { if (serve) { try { serve.kill("SIGKILL"); } catch {} serve = null; } };
process.on("exit", shutdown);
process.on("SIGINT", () => { shutdown(); process.exit(1); });
process.on("SIGTERM", () => { shutdown(); process.exit(1); });

// Wait for the static server. A plain fetch() here raced undici's parser
// against the server's socket teardown and crashed the harness with
// "AssertionError: assert(!this.paused)" (an undici internal, thrown from
// an event handler so try/catch cannot contain it). A raw TCP connect is
// enough to prove the port accepts, with no HTTP parser involved.
const waitPort = (port, ms) => new Promise((resolve) => {
  const deadline = Date.now() + ms;
  const attempt = () => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => {
      s.destroy();
      if (Date.now() > deadline) resolve(false);
      else setTimeout(attempt, 200);
    });
  };
  attempt();
});
if (!(await waitPort(PORT, 10000))) {
  console.log("FATAL: static server did not start on :" + PORT);
  shutdown();
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-sandbox"],
});
const page = await browser.newPage();
const errors = [], reqfail = [], bad = [], requested = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const loc = (m.location && m.location().url) || "";
  if (/favicon\.ico/.test(loc) || /favicon\.ico/.test(m.text())) return;
  errors.push("CONSOLE: " + m.text());
});
page.on("requestfailed", (r) => reqfail.push(r.url() + " :: " + (r.failure() && r.failure().errorText)));
page.on("response", (r) => { if (r.status() >= 400) bad.push(r.status() + " " + r.url()); requested.push(r.url()); });

// A python program whose output is unambiguous in both panes, and which
// exercises a non-trivial interpreter path (a loop + arithmetic, not just
// a bare print). Avoids generator expressions: the vendored py-sh-go
// frontend cannot parse `sum(i*i for i in range(10))` yet (a pre-existing
// parser gap, unrelated to the worker realm this test guards).
const PY = 'print("py worker ok")' + "\n" +
  "total = 0\n" +
  "for i in range(10):\n" +
  "    total += i * i\n" +
  "print(total)\n";

try {
  console.log("otranspiler python-in-worker smoke test");
  const url = PAGE + "#lang=py&target=js&code=" + encodeURIComponent(PY);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#run-btn");

  // the URL-supplied source must NOT auto-run (drive-by execution guard) —
  // press the button explicitly, exactly as a user following the link would.
  await page.click("#run-btn");

  await page.waitForFunction(() => {
    const s = document.getElementById("status");
    return s && /done —|transpile failed|error:/.test(s.textContent || "");
  }, null, { timeout: 300000 });
  await page.waitForTimeout(500);

  const status = await page.locator("#status").innerText();
  const orig = await page.locator("#out-orig").inputValue();
  const tgt = await page.locator("#out-tgt").inputValue();
  const origTag = await page.locator("#tag-orig").innerText().catch(() => "");
  const tgtTag = await page.locator("#tag-tgt").innerText().catch(() => "");
  const diff = await page.locator("#diff-summary").innerText().catch(() => "");

  console.log("  status:  " + status.trim());
  console.log("  orig:    " + JSON.stringify(orig.slice(0, 160)));
  console.log("  tgt:     " + JSON.stringify(tgt.slice(0, 160)));
  console.log("  tags:    orig=" + JSON.stringify(origTag) + " tgt=" + JSON.stringify(tgtTag));

  // 1) the ORIGINAL python side actually ran in a classic worker
  ok(/py worker ok/.test(orig), "the original python pane printed its output", orig.slice(0, 300));
  ok(/285/.test(orig), "the original python pane printed the computed sum", orig.slice(0, 300));
  ok(/exit 0/.test(origTag), "the original run reports exit 0", origTag);

  // 2) the transpiled JS side ran too
  ok(/py worker ok/.test(tgt), "the transpiled JS pane printed its output", tgt.slice(0, 300));
  ok(/285/.test(tgt), "the transpiled JS pane printed the computed sum", tgt.slice(0, 300));

  // 3) the module-worker failure must be GONE — no importScripts error
  //    in any pane, the status line, or the console.
  const allText = [status, orig, tgt, origTag, tgtTag].join("\n");
  ok(!/importScripts/.test(allText), "no importScripts error in any pane/status", allText.slice(0, 400));
  ok(!/Module scripts don't support importScripts/.test(allText), "no module-script importScripts error", allText.slice(0, 400));
  ok(errors.length === 0, "no console/page errors", JSON.stringify(errors.slice(0, 6)));
  ok(reqfail.length === 0, "no failed asset requests", JSON.stringify(reqfail.slice(0, 6)));
  ok(bad.length === 0, "no 4xx/5xx responses", JSON.stringify(bad.slice(0, 6)));

  // 4) the bridge is real: the nested CLASSIC worker is fetched, and the
  //    micropython glue is served under it (importScripts' own request).
  ok(requested.some((u) => /vendor\/py-worker\.js/.test(u)), "the classic py-worker.js bridge was spawned",
    requested.filter((u) => /py-worker/.test(u)).join("\n") || "(never requested)");
  ok(requested.some((u) => /vendor\/micropython\.(js|wasm)/.test(u)), "the micropython engine loaded",
    requested.filter((u) => /micropython/.test(u)).join("\n") || "(never requested)");

  // 5) the outputs agree (the diff is the page's whole point)
  ok(/identical lines/.test(diff), "the page reports a stdout diff", diff);
} catch (e) {
  ok(false, "harness", String((e && e.message) || e));
} finally {
  await browser.close();
  shutdown();
}

console.log("\n" + (failures ? failures + " FAILURE(S)" : "all checks passed"));
if (failures) process.exit(1);
