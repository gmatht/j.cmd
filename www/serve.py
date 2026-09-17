#!/usr/bin/env python3
# ─── serve.py ───────────────────────────────────────────────────
# Static server for the jtsh browser shell with cross-origin
# isolation headers so SharedArrayBuffer (needed for the WASI
# blocking-stdin REPL) is available.
#
# Usage:
#   python3 serve.py [port]     # default 8080
#   open http://localhost:8080/www/
# -----------------------------------------------------------------

import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    # .wasm → application/wasm via the stdlib extension map. Do NOT re-send
    # the header in end_headers(): SimpleHTTPRequestHandler already emits it,
    # and a DUPLICATE Content-Type makes Chromium reject
    # WebAssembly.compileStreaming ("Incorrect response MIME type") — which
    # hangs Pyodide. Python 3.9+ maps .wasm itself; the explicit entry keeps
    # it working on older mimetypes databases.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        # Cross-origin isolation: required for SharedArrayBuffer
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # No caching — we're developing, stale files cause confusing bugs
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[jtsh] {self.address_string()} {fmt % args}\n")


with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
    print(f"jtsh server on http://localhost:{PORT}/www/  (COOP/COEP enabled)")
    httpd.serve_forever()
