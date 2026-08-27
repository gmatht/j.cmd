// ─── bench/remote/server.mjs — logging webserver for remote benchmarks ──
//
// Serves the repo root (so /www/... and /bench/... resolve) with the COOP/COEP
// headers the WASM path needs, and accepts POST /log — the benchmark pages
// POST their results here when they finish — which it appends to a JSONL log
// file. GET /log returns the accumulated log (for the launcher to poll).
//
//   node bench/remote/server.mjs [port] [logfile]
import { createServer } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)); // repo root
const PORT = Number(process.argv[2] || process.env.PORT || 8899);
const LOG = process.argv[3] || process.env.LOG || "/tmp/remote-bench-log.jsonl";
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm",
  ".png": "image/png", ".wav": "audio/wav", ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  if (path === "/log") {
    if (req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      await appendFile(LOG, body + "\n");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "GET") {
      try {
        const data = await readFile(LOG, "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data.trim().split("\n").filter(Boolean)));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
      }
      return;
    }
  }
  // static file from the repo root (path-traversal safe)
  const file = join(ROOT, normalize(path).replace(/^\/+/, ""));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found: " + path);
  }
});
server.listen(PORT, () => console.log(`[remote-bench] logging server on http://localhost:${PORT}  (log: ${LOG})`));
