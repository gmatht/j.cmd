// ─── cython-browser-smoke.mjs — the in-browser Cython 3.3.0 stage ──────
//
// The real Cython compiler runs in a browser worker (Pyodide = CPython 3.12
// in wasm + the pure-Python Cython 3.3.0 wheel vendored under www/vendor/).
// This drives www/auto_cython.html with Playwright and asserts the
// acceptance gate the Node smoke test does natively:
//
//   the generated .py / .pyx CYTHONIZES with 0 errors, in BOTH modes,
//   with no console/page errors and no failed asset requests.
//
//   node bench/cython-browser-smoke.mjs            # both modes
//   node bench/cython-browser-smoke.mjs --headed
//
// First run fetches ~10 MB of vendored wasm; the test budget is generous
// because Pyodide boot dominates.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import pkg from "playwright-core";
const { chromium } = pkg;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CHROME_PATH ||
  "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
// Bind a throwaway socket to get a free port: www/serve.py uses a
// ThreadingTCPServer with allow_reuse_address=False, so a port in TIME_WAIT
// after a previous run cannot be rebound — a fixed port flakes.
const freePort = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const PORT = Number(process.env.CYTHON_TEST_PORT || freePort);
const BASE = `http://127.0.0.1:${PORT}/www/auto_cython.html`;
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
// wait for the static server
let up = false;
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(BASE); if (r.ok) { up = true; break; } } catch {}
  await sleep(200);
}
if (!up) { console.log("FATAL: static server did not start on :" + PORT); shutdown(); process.exit(1); }

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-sandbox"],
});
const page = await browser.newPage();
const errors = [], reqfail = [], bad = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  // Chromium's default /favicon.ico probe 404s on this static page; it is
  // not a page error.
  const loc = (m.location && m.location().url) || "";
  if (/favicon\.ico/.test(loc) || /favicon\.ico/.test(m.text())) return;
  errors.push("CONSOLE: " + m.text());
});
page.on("requestfailed", (r) => reqfail.push(r.url() + " :: " + (r.failure() && r.failure().errorText)));
page.on("response", (r) => { if (r.status() >= 400) bad.push(r.status() + " " + r.url()); });

try {
  console.log("cython browser smoke test");
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".example-btn");
  ok((await page.locator(".example-btn").count()) >= 8, "the example corpus renders");

  for (const mode of ["pure", "pyx"]) {
    console.log("\n" + mode + " mode");
    await page.click(mode === "pyx" ? "#mode-pyx" : "#mode-pure");
    await page.waitForFunction(
      () => /annotated|error/.test(document.getElementById("status").textContent),
      null, { timeout: 90000 });
    await page.waitForTimeout(400);
    const annotated = await page.locator("#status").innerText();
    ok(/annotated/.test(annotated), mode + ": the generated file is produced", annotated);

    await page.evaluate(() => { const t = document.getElementById("tag-cython"); if (t) t.textContent = ""; });
    await page.click("#cython-btn");
    await page.waitForFunction(
      () => /cythonized|failed|worker error/.test(document.getElementById("tag-cython").textContent || ""),
      null, { timeout: 240000 });
    const tag = await page.locator("#tag-cython").innerText();
    ok(/cythonized ✓ 0 errors/.test(tag), mode + ": real Cython 3.3.0 compiles it with 0 errors", tag);
    const head = (await page.locator("#out-cython").inputValue()).split("\n")[0];
    ok(/Cython 3\.3\.0/.test(head), mode + ": the Cython version is stamped", head);
    ok(/line/.test(head) || /lines of C/.test(head), mode + ": the emitted C line count is reported", head);
  }

  // ── negative control: the compiler must REJECT a malformed .pyx, or the
  //    "0 errors" above would be vacuous (a compiler that never errors).
  //    A second worker; Pyodide is ~10 MB and serve.py sends no-store.
  console.log("\nnegative control (malformed .pyx)");
  const badRes = await page.evaluate(async () => {
    const w = new Worker("/www/vendor/cython-worker.js");
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("boot timeout")), 180000);
      w.addEventListener("message", (e) => { if (e.data && e.data.type === "ready") { clearTimeout(to); res(); } });
      w.addEventListener("error", (e) => { clearTimeout(to); rej(new Error((e && e.message) || "worker error")); }, { once: true });
      w.postMessage({ type: "init" });
    });
    const done = await new Promise((res) => {
      w.addEventListener("message", (e) => { if (e.data && e.data.type === "done") res(e.data); });
      w.postMessage({ type: "job", jobId: 1, mode: "pyx", source: "cdef int x\nx = (1 + \n" });
    });
    w.terminate();
    return { ok: done.ok, errors: done.result && done.result.errors, log: done.result && done.result.log };
  });
  ok(badRes.ok === false, "a malformed .pyx reports ok:false", JSON.stringify(badRes).slice(0, 200));
  ok((badRes.errors && badRes.errors !== 0) || /error/i.test(badRes.log || ""), "the Cython diagnostics are surfaced", JSON.stringify(badRes).slice(0, 200));

  ok(errors.length === 0, "no console/page errors", JSON.stringify(errors.slice(0, 6)));
  ok(reqfail.length === 0, "no failed asset requests", JSON.stringify(reqfail.slice(0, 6)));
  ok(bad.length === 0, "no 4xx/5xx responses", JSON.stringify(bad.slice(0, 6)));
} catch (e) {
  ok(false, "harness", String(e && e.message || e));
} finally {
  await browser.close();
  shutdown();
}

console.log("\n" + (failures ? failures + " FAILURE(S)" : "all checks passed"));
if (failures) process.exit(1);
