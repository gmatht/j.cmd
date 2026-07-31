#!/usr/bin/env python3
# ─── serve.py ───────────────────────────────────────────────────
# Static server for the tinysh browser shell with cross-origin
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
    def end_headers(self):
        # Cross-origin isolation: required for SharedArrayBuffer
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # No caching — we're developing, stale files cause confusing bugs
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # WASM MIME type
        if self.path.endswith(".wasm"):
            self.send_header("Content-Type", "application/wasm")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[tinysh] {self.address_string()} {fmt % args}\n")


with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
    print(f"tinysh server on http://localhost:{PORT}/www/  (COOP/COEP enabled)")
    httpd.serve_forever()
