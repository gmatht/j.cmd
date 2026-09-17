// ─── __module-worker-test.mjs — the otranspiler stage workers ────
//
// The otranspiler page runs each stage (transpile / original run /
// target run) in a MODULE Web Worker (www/otranspile-job.js). A module
// worker is a different realm from the page: no `document`, and NO
// import map — two things the tcc/go/zig runtimes depended on, and both
// of which failed silently-to-loudly:
//
//   1. ensurePako() early-returned when `document` was undefined (the
//      CLI check), so in a worker pako was never loaded and tcc/go threw
//      "no inflate available (pako.min.js not loaded)".
//   2. src/wasm.js imported the BARE specifiers "@wasmer/wasi" /
//      "@wasmer/wasmfs", which only the page's import map resolves →
//      in a worker: "Failed to resolve module specifier".
//   3. (adjacent) the shell C runtime stubbed fputs/fputc to -1, so a
//      transpiled C program printed nothing while exiting 0.
//
// This test boots a real module worker against a static server and runs
// the same runJob() entry the page uses for the `c` and `go` targets.
// Browser-only: it needs the cached Chromium + playwright-core.
//
//   node __module-worker-test.mjs
//
// Exit 0 = both engines ran in a module worker (and the transpiled C
// program produced its stdout).
import { spawn } from "node:child_process";
import net from "node:net";
import { chromium } from "playwright-core";

const ROOT = new URL(".", import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH ||
  "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";

// Pick a free port (a hardcoded one collides with a leftover dev server
// and then the readiness fetch can hit the WRONG server while our own
// spawn failed to bind — the goto then races a server we don't own).
const PORT = await new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});
const BASE = `http://127.0.0.1:${PORT}/www/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serve = spawn("python3", ["www/serve.py", String(PORT)], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
});
serve.stderr.on("data", (d) => {
  // Quiet by default (the static server logs every request); surface the
  // banner/errors only, so the test output stays readable.
  const s = d.toString();
  if (/Traceback|Error|error|Address already in use/.test(s)) process.stderr.write("[serve] " + s);
});
// Wait for the server to accept connections (a fixed sleep is flaky on a
// loaded box, and a refused goto aborts before the checks can run).
let up = false;
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(BASE + "index.html");
    if (r.ok) { up = true; break; }
  } catch {}
  await sleep(200);
}
if (!up) {
  console.error(`✗ static server never came up on ${BASE}`);
  serve.kill();
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-sandbox"],
});
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));

  // The page provides the import map; the WORKER must not need it. Load a
  // blank page on the same origin so the worker can fetch src/ + www/.
  await page.goto(BASE + "index.html");

  // Run one engine inside a module worker and return its { out, err, code }.
  const runInModuleWorker = (lang, source) =>
    page.evaluate(
      ({ lang, source }) =>
        new Promise((resolve) => {
          const w = new Worker(new URL("/www/__module-worker-probe.js", location.href), { type: "module" });
          const to = setTimeout(() => { resolve({ timeout: true, err: "worker timeout" }); w.terminate(); }, 180000);
          w.onmessage = (e) => {
            if (e.data && e.data.type === "status") return;   // progress note, not the result
            clearTimeout(to); resolve(e.data); w.terminate();
          };
          w.onerror = (e) => { clearTimeout(to); resolve({ err: String(e.message || e) }); };
          w.postMessage({ lang, source });
        }),
      { lang, source }
    );

  // 1) tcc — the reported failure. Pre-fix: "tcc: no inflate available".
  const c = await runInModuleWorker(
    "c",
    '#include <stdio.h>\nint main(void){ printf("hi tcc worker\\n"); return 0; }\n'
  );
  check("tcc runs in a module worker", c && c.code === 0 && c.out === "hi tcc worker\n",
    JSON.stringify({ code: c && c.code, out: c && c.out, err: c && c.err }));

  // 2) go — the same pako path (the gzipped GOROOT bundle).
  const go = await runInModuleWorker(
    "go",
    'package main\nimport "fmt"\nfunc main() { fmt.Println("hi go worker") }\n'
  );
  check("go runs in a module worker", go && go.code === 0 && go.out === "hi go worker\n",
    JSON.stringify({ code: go && go.code, out: go && go.out, err: go && go.err }));

  // 3) fputs — the C→C shell-out lowering emits fputs("…", stdout); the
  //    old stub returned -1 and dropped it (exit 0, empty output).
  const gen = await page.evaluate(
    async () => {
      const { transpileJob, runJob } = await import("/src/otranspile-jobs.js");
      const src = '#include <stdio.h>\nint main(void){ printf("hello c\\n"); return 0; }\n';
      const tr = await transpileJob(src, "c", "c", {});
      const run = await runJob("c", tr.text, {});
      return { usesFputs: /fputs\s*\(/.test(tr.text), run };
    }
  );
  check("transpiled C emits stdout (fputs)", gen.run.code === 0 && gen.run.out === "hello c\n",
    JSON.stringify({ usesFputs: gen.usesFputs, code: gen.run.code, out: gen.run.out, err: gen.run.err }));
} finally {
  await browser.close();
  serve.kill();
}

console.log(failures ? `\n✗ ${failures} module-worker check(s) failed` : "\n✓ module-worker checks passed");
process.exit(failures ? 1 : 0);
