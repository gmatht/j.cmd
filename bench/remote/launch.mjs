// ─── bench/remote/launch.mjs — point Windows Firefox at a benchmark page ──
//
// Starts the logging server, launches the REAL Windows Firefox (which has the
// real iGPU / D3D11-ANGLE) at the page, and waits for the page to POST its
// results to /log. This is how the branchless/gcc-vs-igpu benchmarks can be
// measured on real hardware from WSL2 (WSL2 forwards localhost, so the Windows
// browser reaches the WSL server).
//
//   node bench/remote/launch.mjs [page] [port]
//     page defaults to www/branchless-bench.html
//
// Browser: set BROWSER to a Windows browser exe. Defaults to Brave (Chromium)
// because Firefox routes localhost through the system proxy by default and the
// proxy can't reach the WSL server — Chromium bypasses the proxy for localhost.
// (Firefox fix: set network.proxy.no_proxies_on to "localhost,127.0.0.1".)
import { spawn } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BROWSER = process.env.BROWSER || "/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
const PAGE = process.argv[2] || "www/branchless-bench.html";
const PORT = Number(process.argv[3] || process.env.PORT || 8899);
const LOG = process.env.LOG || "/tmp/remote-bench-log.jsonl";
const PAGE_URL = `http://localhost:${PORT}/${PAGE}`;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 180000);

// start the logging server
const server = spawn("node", [fileURLToPath(new URL("./server.mjs", import.meta.url)), String(PORT), LOG], { stdio: "inherit" });
try { rmSync(LOG); } catch { /* no old log */ }
await new Promise((r) => setTimeout(r, 600)); // let the server bind

console.log(`[remote-bench] launching ${BROWSER}\n[remote-bench]   at ${PAGE_URL}\n[remote-bench]   (log: ${LOG}, timeout ${TIMEOUT_MS / 1000}s)`);
const fx = spawn(BROWSER, [PAGE_URL], { stdio: "ignore", detached: true });
fx.unref();

// poll the log until the page POSTs its results
const deadline = Date.now() + TIMEOUT_MS;
let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  if (existsSync(LOG)) {
    const data = readFileSync(LOG, "utf8").trim();
    if (data && data !== last) {
      last = data;
      console.log("\n=== results from the browser ===");
      for (const line of data.split("\n")) {
        try { console.log(JSON.stringify(JSON.parse(line), null, 2)); } catch { console.log(line); }
      }
      server.kill();
      process.exit(0);
    }
  }
}
console.log(`[remote-bench] TIMEOUT — no results within ${TIMEOUT_MS / 1000}s (is Firefox open? did the page error?)`);
server.kill();
process.exit(1);
