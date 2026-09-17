// ─── otranspiler-worker-smoke.mjs — the tcc/go stage workers ─────────
//
// REGRESSION GUARD for the MODULE-WORKER realm bugs that shipped to
// https://gmatht.github.io/j.cmd/www/otranspiler.html#lang=py&target=c :
//
//   [stderr] tcc: no inflate available (pako.min.js not loaded)
//
// The otranspiler runs each stage in a MODULE Web Worker
// (www/otranspile-job.js). A module worker is a different realm from the
// page: no `document`, and NO import map. Two runtimes assumed otherwise:
//
//   1. ensurePako() early-returned when `document` was undefined (the CLI
//      guard), so pako was never loaded in a worker → tcc/go threw
//      "no inflate available" while inflating tcc-include.dat / goroot.dat.
//   2. src/wasm.js imported the BARE specifiers "@wasmer/wasi" /
//      "@wasmer/wasmfs", which only the page's import map resolves →
//      "Failed to resolve module specifier" in a worker.
//   3. (adjacent) the shell C runtime stubbed fputs/fputc to -1, so a
//      transpiled C program exited 0 and printed nothing.
//
// The plain Node harnesses (deploy-gates.sh) cannot see any of this: the
// bugs only exist in a browser realm, and only in a *module worker*. This
// harness boots the real page over the static server and runs the same
// runJob() entry the page uses, in a real module worker, for `c` and
// `go` (plus the C→C render that emits fputs).
//
//   node bench/otranspiler-worker-smoke.mjs            # headless
//   node bench/otranspiler-worker-smoke.mjs --headed
//
// Exits 0 with a SKIP line when no chromium is installed (a missing
// browser says nothing about the code; CI installs one — see pages.yml).
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import net from "node:net";
import pkg from "playwright-core";
const { chromium } = pkg;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Chromium is a CI dependency, not a repo one. When it is absent the
// honest behaviour is SKIP, not FAIL (see pages.yml, which installs it so
// CI enforces the same browser checks as a ca.dansted.org deploy). The
// Playwright cache dir encodes a BUILD NUMBER (chromium-1234) that
// changes when playwright-core is bumped — glob it, don't pin it.
function playwrightChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.HOME ? `${process.env.HOME}/.cache/ms-playwright` : null,
    "/root/.cache/ms-playwright",
  ].filter(Boolean);
  for (const root of roots) {
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
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
  console.log("SKIP otranspiler tcc/go module-worker smoke: no chromium found");
  console.log("     (looked in: " + CANDIDATES.join(", ") + ")");
  console.log("     install with: npx playwright install chromium   — or set CHROME_PATH");
  process.exit(0);
}

const freePort = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const PORT = Number(process.env.OTRANSPILER_WORKER_TEST_PORT || freePort);
const PAGE = `http://127.0.0.1:${PORT}/www/otranspiler.html`;
const headed = process.argv.includes("--headed");

let serve = spawn("python3", ["www/serve.py", String(PORT)], { cwd: ROOT, stdio: "ignore" });
const shutdown = () => { if (serve) { try { serve.kill("SIGKILL"); } catch {} serve = null; } };
process.on("exit", shutdown);
process.on("SIGINT", () => { shutdown(); process.exit(1); });
process.on("SIGTERM", () => { shutdown(); process.exit(1); });

// Raw TCP connect to prove the port is up. A plain fetch() here raced
// undici's parser against the server's socket teardown and crashed the
// harness with an internal AssertionError (see the py-worker smoke).
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

let failures = 0;
const ok = (cond, what, detail) => {
  if (cond) { console.log("  ok   " + what); return; }
  failures++;
  console.log("  FAIL " + what + (detail ? "\n       " + detail : ""));
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-sandbox"],
});

// Run one engine inside a REAL module worker (the page's otranspile-job.js
// shape) and return its runJob() record.
async function runInModuleWorker(page, lang, source) {
  return page.evaluate(
    ({ lang, source }) =>
      new Promise((resolve) => {
        const w = new Worker(new URL("/www/otranspile-job.js", location.href), { type: "module" });
        const to = setTimeout(() => { resolve({ timeout: true, err: "worker timeout" }); try { w.terminate(); } catch {} }, 240000);
        w.onmessage = (e) => {
          const m = e.data || {};
          if (m.type === "ready" || m.type === "status") return;   // protocol chatter
          if (m.type !== "done") return;
          clearTimeout(to);
          try { w.terminate(); } catch {}
          resolve(m.ok ? (m.result || {}) : { out: "", err: String(m.error || "worker failed"), code: 1 });
        };
        w.onerror = (e) => { clearTimeout(to); resolve({ out: "", err: String(e.message || e), code: 1 }); };
        w.postMessage({ type: "init" });
        w.postMessage({ type: "job", jobId: 1, kind: "run", lang, code: source });
      }),
    { lang, source }
  );
}

try {
  console.log("otranspiler tcc/go module-worker smoke test");
  const page = await browser.newPage();
  await page.goto(PAGE, { waitUntil: "load" });
  await page.waitForSelector("#run-btn");

  // 1) tcc — the reported failure. Pre-fix: "tcc: no inflate available".
  const c = await runInModuleWorker(
    page, "c",
    '#include <stdio.h>\nint main(void){ printf("hi tcc worker\\n"); return 0; }\n'
  );
  ok(c && c.code === 0 && c.out === "hi tcc worker\n",
    "tcc runs in a module worker (pako inflate of tcc-include.dat)",
    JSON.stringify({ code: c && c.code, out: c && c.out, err: c && c.err }));

  // 2) go — the same pako path (the gzipped GOROOT bundle) plus the
  //    worker-side wasm_exec glue.
  const go = await runInModuleWorker(
    page, "go",
    'package main\nimport "fmt"\nfunc main() { fmt.Println("hi go worker") }\n'
  );
  ok(go && go.code === 0 && go.out === "hi go worker\n",
    "go runs in a module worker (pako inflate of goroot.dat)",
    JSON.stringify({ code: go && go.code, out: go && go.out, err: go && go.err }));

  // 3) the C→C shell-out lowering emits fputs("…", stdout); the shell C
  //    runtime must actually write it (the old stub returned -1 → exit 0,
  //    empty output).
  const gen = await page.evaluate(async () => {
    const { transpileJob, runJob } = await import("/src/otranspile-jobs.js");
    const src = '#include <stdio.h>\nint main(void){ printf("hello c\\n"); return 0; }\n';
    const tr = await transpileJob(src, "c", "c", {});
    const run = await runJob("c", tr.text, {});
    return { usesFputs: /fputs\s*\(/.test(tr.text), run };
  });
  ok(gen.run.code === 0 && gen.run.out === "hello c\n",
    "transpiled C emits stdout (fputs)",
    JSON.stringify({ usesFputs: gen.usesFputs, code: gen.run.code, out: gen.run.out, err: gen.run.err }));
} catch (e) {
  failures++;
  console.log("  FAIL harness error: " + (e && e.message ? e.message : e));
} finally {
  await browser.close();
  shutdown();
}

console.log(failures ? `\n✗ ${failures} module-worker check(s) failed` : "\n✓ tcc/go module-worker checks passed");
process.exit(failures ? 1 : 0);
